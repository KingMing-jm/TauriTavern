#include <node.h>
#include <cstring>
#include <memory>
#include <vector>

// libuv may rewrite argv (for process.title), so Rust-owned immutable CStrings
// must not be passed directly. Keep a contiguous writable allocation alive until
// the Node event loop has returned. This is called once per Android app process.
extern "C" int tt_outfit_node_start(int argc, const char* const* input) {
    if (argc <= 0 || input == nullptr) return -1;
    std::size_t size = 0;
    for (int i = 0; i < argc; ++i) {
        if (input[i] == nullptr) return -1;
        size += std::strlen(input[i]) + 1;
    }
    auto storage = std::make_unique<char[]>(size);
    std::vector<char*> arguments(static_cast<std::size_t>(argc) + 1, nullptr);
    char* current = storage.get();
    for (int i = 0; i < argc; ++i) {
        const auto length = std::strlen(input[i]) + 1;
        std::memcpy(current, input[i], length);
        arguments[static_cast<std::size_t>(i)] = current;
        current += length;
    }
    return node::Start(argc, arguments.data());
}
