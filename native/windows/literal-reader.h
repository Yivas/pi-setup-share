#ifndef PI_SETUP_SHARE_LITERAL_READER_H
#define PI_SETUP_SHARE_LITERAL_READER_H

#include <windows.h>

// Source-only Windows boundary. Callers supply a root handle AND an independently
// trusted expected identity; deriving that identity from an untrusted path is not authentication.
typedef enum LiteralReaderResult {
    LITERAL_READER_OK = 0,
    LITERAL_READER_INVALID = 1,
    LITERAL_READER_CHANGED = 2,
    LITERAL_READER_REPARSE = 3,
    LITERAL_READER_OPEN_FAILED = 4,
    LITERAL_READER_IO_ERROR = 5
} LiteralReaderResult;

LiteralReaderResult literal_reader_validate_root(
    HANDLE root, const BY_HANDLE_FILE_INFORMATION *trusted_identity);

// Open exactly one child component relative to a previously validated directory.
// The expected identity must come from a trusted inventory or a pinned handle.
// On success only, the caller owns *opened and must close it before releasing the root.
LiteralReaderResult literal_reader_open_child(
    HANDLE parent, const wchar_t *name, BOOL directory,
    const BY_HANDLE_FILE_INFORMATION *expected_identity, HANDLE *opened);

#endif
