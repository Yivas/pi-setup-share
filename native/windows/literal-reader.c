#include "literal-reader.h"
#include <winternl.h>
#include <string.h>
#include <wchar.h>

#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef FILE_NON_DIRECTORY_FILE
#define FILE_NON_DIRECTORY_FILE 0x00000040
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif

typedef NTSTATUS(NTAPI *NtCreateFileFn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

static int same_identity(const BY_HANDLE_FILE_INFORMATION *left,
    const BY_HANDLE_FILE_INFORMATION *right) {
    return left->dwVolumeSerialNumber == right->dwVolumeSerialNumber &&
        left->nFileIndexHigh == right->nFileIndexHigh &&
        left->nFileIndexLow == right->nFileIndexLow;
}

static LiteralReaderResult inspect(HANDLE handle, BOOL directory,
    const BY_HANDLE_FILE_INFORMATION *expected) {
    FILE_ATTRIBUTE_TAG_INFO tag;
    FILE_STANDARD_INFO standard;
    BY_HANDLE_FILE_INFORMATION identity;
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
        !GetFileInformationByHandle(handle, &identity)) return LITERAL_READER_IO_ERROR;
    if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return LITERAL_READER_REPARSE;
    if ((standard.Directory ? TRUE : FALSE) != directory || !same_identity(&identity, expected))
        return LITERAL_READER_CHANGED;
    return LITERAL_READER_OK;
}

LiteralReaderResult literal_reader_validate_root(
    HANDLE root, const BY_HANDLE_FILE_INFORMATION *trusted_identity) {
    if (!root || root == INVALID_HANDLE_VALUE || !trusted_identity) return LITERAL_READER_INVALID;
    return inspect(root, TRUE, trusted_identity);
}

static int valid_component(const wchar_t *name, size_t *length) {
    if (!name) return 0;
    for (size_t index = 0; index <= 255; index++) {
        wchar_t character = name[index];
        if (character == L'\0') {
            *length = index;
            return index > 0 && name[index - 1] != L'.' && name[index - 1] != L' ' &&
                !(index == 1 && name[0] == L'.') &&
                !(index == 2 && name[0] == L'.' && name[1] == L'.');
        }
        if (character < 32 || character == L'\\' || character == L'/' || character == L':' ||
            character == L'*' || character == L'?' || character == L'"' ||
            character == L'<' || character == L'>' || character == L'|') return 0;
    }
    return 0;
}

LiteralReaderResult literal_reader_open_child(HANDLE parent, const wchar_t *name,
    BOOL directory, const BY_HANDLE_FILE_INFORMATION *expected_identity, HANDLE *opened) {
    if (!opened) return LITERAL_READER_INVALID;
    *opened = INVALID_HANDLE_VALUE;
    size_t length = 0;
    if (!parent || parent == INVALID_HANDLE_VALUE || !expected_identity ||
        (directory != TRUE && directory != FALSE) || !valid_component(name, &length))
        return LITERAL_READER_INVALID;
    FILE_ATTRIBUTE_TAG_INFO parent_tag;
    FILE_STANDARD_INFO parent_info;
    if (!GetFileInformationByHandleEx(parent, FileAttributeTagInfo, &parent_tag, sizeof(parent_tag)) ||
        !GetFileInformationByHandleEx(parent, FileStandardInfo, &parent_info, sizeof(parent_info)))
        return LITERAL_READER_IO_ERROR;
    if ((parent_tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || !parent_info.Directory)
        return LITERAL_READER_REPARSE;

    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    if (!module) return LITERAL_READER_IO_ERROR;
    FARPROC procedure = GetProcAddress(module, "NtCreateFile");
    NtCreateFileFn nt = NULL;
    if (!procedure || sizeof(nt) != sizeof(procedure)) return LITERAL_READER_IO_ERROR;
    memcpy(&nt, &procedure, sizeof(nt));
    UNICODE_STRING native_name;
    native_name.Buffer = (PWSTR)name;
    native_name.Length = (USHORT)(length * sizeof(wchar_t));
    native_name.MaximumLength = native_name.Length;
    OBJECT_ATTRIBUTES attributes;
    InitializeObjectAttributes(&attributes, &native_name, OBJ_CASE_INSENSITIVE, parent, NULL);
    IO_STATUS_BLOCK io;
    HANDLE child = INVALID_HANDLE_VALUE;
    const ACCESS_MASK access = (directory ? FILE_LIST_DIRECTORY : FILE_READ_DATA) |
        FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    // Read-share denies concurrent write handles on files for the entire held read.
    // Directory names can still change; every child needs its own expected identity.
    const ULONG sharing = directory ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ;
    NTSTATUS status = nt(&child, access, &attributes, &io, NULL, 0, sharing, FILE_OPEN,
        FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
            (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), NULL, 0);
    // Sharing violations, missing entries and other open errors all fail closed.
    // Do not claim which condition occurred without translating the NTSTATUS.
    if (status < 0) return LITERAL_READER_OPEN_FAILED;
    LiteralReaderResult checked = inspect(child, directory, expected_identity);
    if (checked != LITERAL_READER_OK) {
        if (!CloseHandle(child)) return LITERAL_READER_IO_ERROR;
        return checked;
    }
    *opened = child;
    return LITERAL_READER_OK;
}
