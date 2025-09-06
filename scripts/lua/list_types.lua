local ffi = require('ffi')

ffi.cdef[[
const char* engine_list_types(void);
const char* engine_last_error(void);
]]

local function err_json(msg)
  io.stderr:write(string.format('{"error":"%s"}\n', msg))
end

local function dirname(p) return (p and p:match("^(.*)/[^/]+$")) or "." end
local script_dir = dirname(arg and arg[0])
local env_path = os.getenv("LIBENGINE_PATH") or os.getenv("TAZOR_LIBENGINE")

local tried, errors = {}, {}
local function try_load(p)
  local ok,lib = pcall(ffi.load, p)
  tried[#tried+1] = p
  if ok then return lib end
  errors[#errors+1] = tostring(lib)
  return nil
end

local lib
if env_path then lib = try_load(env_path) end
if not lib then lib = try_load("./libengine.so") end                          -- repo root (CWD)
if not lib then lib = try_load("scripts/libengine.so") end                    -- scripts/
if not lib then lib = try_load("scripts/lua/../../libengine.so") end          -- scripts/lua/../../

if not lib then
  err_json("failed to load libengine.so")
  os.exit(1)
end

local types_json = lib.engine_list_types()
if types_json == nil then
  local cstr = lib.engine_last_error()
  local msg = cstr ~= nil and ffi.string(cstr) or "engine_list_types failed"
  err_json(msg)
  os.exit(1)
end

io.write(ffi.string(types_json))