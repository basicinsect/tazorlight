local ffi = require('ffi')

ffi.cdef[[
typedef void* engine_graph_t;
typedef enum { ENG_TYPE_NUMBER = 0, ENG_TYPE_STRING = 1, ENG_TYPE_BOOL = 2 } eng_type_t;

engine_graph_t engine_graph_create(void);
void           engine_graph_destroy(engine_graph_t g);

int engine_graph_add_node_with_id(engine_graph_t g, int node_id, const char* type, const char* name);

int engine_graph_set_param_number(engine_graph_t g, int node_id, const char* key, double value);
int engine_graph_set_param_string(engine_graph_t g, int node_id, const char* key, const char* value);
int engine_graph_set_param_bool  (engine_graph_t g, int node_id, const char* key, int value);

int engine_graph_connect(engine_graph_t g, int from_node, int from_output_idx, int to_node, int to_input_idx);
int engine_graph_add_output(engine_graph_t g, int node_id, int out_index);

int engine_graph_run(engine_graph_t g);

int        engine_graph_get_output_count(engine_graph_t g);
eng_type_t engine_graph_get_output_type (engine_graph_t g, int index);
int        engine_graph_get_output_number(engine_graph_t g, int index, double* out);
int        engine_graph_get_output_bool  (engine_graph_t g, int index, int* out);
const char* engine_graph_get_output_string(engine_graph_t g, int index);

const char* engine_last_error(void);
]]

local function json_escape(s)
  s = tostring(s or "")
  s = s:gsub('\\','\\\\'):gsub('"','\\"'):gsub('\b','\\b'):gsub('\f','\\f'):gsub('\n','\\n'):gsub('\r','\\r'):gsub('\t','\\t')
  return s
end
local function err_json(msg, tried, errs)
  local extra = ""
  if tried and #tried > 0 then
    extra = '", "tried": ["' .. table.concat(tried, '","') .. '"]'
    if errs and #errs > 0 then
      extra = extra .. ', "errors": ["' .. table.concat(errs, '","'):gsub('\n',' ') .. '"]'
    end
  end
  io.stderr:write(string.format('{"error":"%s%s"}\n', json_escape(msg), extra))
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
if not lib then lib = try_load("./libengine.so") end                          -- server cwd = repo root
if not lib then lib = try_load(script_dir.."/../../libengine.so") end         -- from scripts/lua/
if not lib then lib = try_load(script_dir.."/../libengine.so") end            -- scripts/
if not lib then lib = try_load(script_dir.."/libengine.so") end               -- same dir
if not lib then lib = try_load("libengine.so") end                            -- system path

if not lib then
  err_json("failed to load libengine.so", tried, errors)
  os.exit(1)
end

local function read_all_stdin()
  local all = io.read("*a")
  return all or ""
end

local function parse_and_build(plan)
  local g = lib.engine_graph_create()
  if g == nil then
    err_json("engine_graph_create failed")
    return nil
  end

  local function ensure_ok(rc, ctx)
    if rc ~= 0 then
      local cstr = lib.engine_last_error()
      local msg = cstr ~= nil and ffi.string(cstr) or ("unknown error @ "..ctx)
      err_json(ctx..": "..msg)
      lib.engine_graph_destroy(g)
      return false
    end
    return true
  end

  for line in plan:gmatch("[^\r\n]+") do
    line = line:match("^%s*(.-)%s*$")
    if line ~= "" then
      local head, rest = line:match("^(%S+)%s*(.*)$")
      if head == "NODES" then
        -- noop
      elseif head == "NODE" then
        local id, typeName, tail = rest:match("^(%S+)%s+(%S+)%s*(.*)$")
        if not id or not typeName then
          lib.engine_graph_destroy(g); err_json("NODE line malformed: "..line); return nil
        end
        id = tonumber(id)
        if not ensure_ok(lib.engine_graph_add_node_with_id(g, id, typeName, nil), "add_node "..typeName) then return nil end
        for kv in (tail or ""):gmatch("(%S+)") do
          local k, v = kv:match("^(.-)=(.*)$")
          if k and v then
            local num = tonumber(v)
            if num then
              if not ensure_ok(lib.engine_graph_set_param_number(g, id, k, num), "set_param_number "..k) then return nil end
            else
              if not ensure_ok(lib.engine_graph_set_param_string(g, id, k, v), "set_param_string "..k) then return nil end
            end
          end
        end
      elseif head == "CONNECTION" then
        local a, ao, b, bi = rest:match("^(%S+)%s+(%S+)%s+(%S+)%s+(%S+)$")
        if not a then lib.engine_graph_destroy(g); err_json("CONNECTION line malformed: "..line); return nil end
        if not ensure_ok(lib.engine_graph_connect(g, tonumber(a), tonumber(ao), tonumber(b), tonumber(bi)), "connect") then return nil end
      elseif head == "OUTPUT" then
        local nid, oidx = rest:match("^(%S+)%s+(%S+)$")
        if not nid then lib.engine_graph_destroy(g); err_json("OUTPUT line malformed: "..line); return nil end
        if not ensure_ok(lib.engine_graph_add_output(g, tonumber(nid), tonumber(oidx)), "add_output") then return nil end
      else
        -- ignore unknown lines
      end
    end
  end

  return g
end

local function run_and_emit_json(g)
  local rc = lib.engine_graph_run(g)
  if rc ~= 0 then
    local cstr = lib.engine_last_error()
    local msg = cstr ~= nil and ffi.string(cstr) or "run failed"
    err_json(msg)
    lib.engine_graph_destroy(g)
    return false
  end

  local count = lib.engine_graph_get_output_count(g)
  io.write('{"outputs":[')
  for i = 0, count - 1 do
    if i > 0 then io.write(',') end
    local t = lib.engine_graph_get_output_type(g, i)
    if t == ffi.C.ENG_TYPE_NUMBER then
      local out = ffi.new("double[1]")
      lib.engine_graph_get_output_number(g, i, out)
      io.write(string.format('{"index":%d,"type":"number","value":%s}', i, tostring(out[0])))
    elseif t == ffi.C.ENG_TYPE_STRING then
      local s = lib.engine_graph_get_output_string(g, i)
      local str = s ~= nil and ffi.string(s) or ""
      io.write(string.format('{"index":%d,"type":"string","value":"%s"}', i, json_escape(str)))
    elseif t == ffi.C.ENG_TYPE_BOOL then
      local out = ffi.new("int[1]")
      lib.engine_graph_get_output_bool(g, i, out)
      io.write(string.format('{"index":%d,"type":"bool","value":%s}', i, (out[0] ~= 0) and "true" or "false"))
    else
      io.write(string.format('{"index":%d,"type":"unknown"}', i))
    end
  end
  io.write("]}\n")
  lib.engine_graph_destroy(g)
  return true
end

local plan = read_all_stdin()
local g = parse_and_build(plan)
if not g then os.exit(2) end
if not run_and_emit_json(g) then os.exit(3) end
