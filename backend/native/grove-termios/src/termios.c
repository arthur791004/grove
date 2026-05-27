// Minimal N-API binding to read termios flags from a pty master fd.
// Exposed: getTermios(fd) -> { icanon: bool, echo: bool, isig: bool } | null
//
// Used by Grove to detect when a foreground process has put the pty into
// raw/cbreak mode (ICANON off) — that's the canonical signal a TUI is
// running, so we can flip the renderer to raw-mode without maintaining a
// hardcoded list of interactive command names.

#include <node_api.h>
#include <termios.h>
#include <errno.h>

static napi_value GetTermios(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd (int32) required");
    return NULL;
  }

  struct termios t;
  if (tcgetattr(fd, &t) != 0) {
    napi_value nul;
    napi_get_null(env, &nul);
    return nul;
  }

  napi_value out;
  napi_create_object(env, &out);

  napi_value v;
  napi_get_boolean(env, (t.c_lflag & ICANON) != 0, &v);
  napi_set_named_property(env, out, "icanon", v);
  napi_get_boolean(env, (t.c_lflag & ECHO) != 0, &v);
  napi_set_named_property(env, out, "echo", v);
  napi_get_boolean(env, (t.c_lflag & ISIG) != 0, &v);
  napi_set_named_property(env, out, "isig", v);

  return out;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "getTermios", NAPI_AUTO_LENGTH, GetTermios, NULL, &fn);
  napi_set_named_property(env, exports, "getTermios", fn);
  return exports;
}
