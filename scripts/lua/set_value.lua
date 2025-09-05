local ffi = require('ffi')
ffi.cdef[[
void engine_set_value(int value);
]]
local lib = ffi.load('./libengine.so')
local arg_value = tonumber(arg[1]) or 0
lib.engine_set_value(arg_value)
