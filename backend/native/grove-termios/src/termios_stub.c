// Windows stub — Grove only runs on macOS/Linux today, but keep the build
// green if anyone tries to compile here.

#include <node_api.h>

static napi_value GetTermios(napi_env env, napi_callback_info info) {
  napi_value nul;
  napi_get_null(env, &nul);
  return nul;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "getTermios", NAPI_AUTO_LENGTH, GetTermios, NULL, &fn);
  napi_set_named_property(env, exports, "getTermios", fn);
  return exports;
}
