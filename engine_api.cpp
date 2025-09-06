#include "engine_api.h"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>

// Taskflow (header-only)
#include <taskflow/taskflow.hpp>   // git submodule/clone; include path added in build

namespace eng {

// ========= error buffer (thread-local) =========
static thread_local std::string g_last_error;
static const char* c_error(const std::string& s) { g_last_error = s; return g_last_error.c_str(); }

// ========= core types =========
enum class Type { Number, String, Bool };

struct Value {
    Type type;
    std::variant<double, std::string, bool> data;
    static Value num(double v) { return {Type::Number, v}; }
    static Value str(std::string v) { return {Type::String, std::move(v)}; }
    static Value boolean(bool v) { return {Type::Bool, v}; }
};

struct NodeType;

struct Node {
    int id = 0;
    const NodeType* type = nullptr;  // not owning
    std::string name;
    std::unordered_map<std::string, Value> params;
    std::vector<Value> inputValues;
    std::vector<Value> outputValues;
};

using ComputeFn = bool(*)(Node& n, std::string& err);

struct ParamSpec {
    std::string name;
    Type type;
    Value defaultValue;
    std::vector<std::string> enumOptions;  // empty if not an enum
    std::string description;
};

struct NodeType {
    std::string name;               // "Number", "Add", ...
    std::vector<Type> inputs;       // arity and types
    std::vector<Type> outputs;
    std::vector<ParamSpec> params;  // parameter specifications
    std::string version;            // version info
    std::string description;        // description of the node
    ComputeFn compute;
};

struct Edge { int fromNode; int fromOut; int toNode; int toIn; };
struct OutputPin { int node; int outIdx; };

// JSON generation helpers
static std::string escapeJson(const std::string& str) {
    std::string escaped;
    for (char c : str) {
        if (c == '"') escaped += "\\\"";
        else if (c == '\\') escaped += "\\\\";
        else if (c == '\b') escaped += "\\b";
        else if (c == '\f') escaped += "\\f";
        else if (c == '\n') escaped += "\\n";
        else if (c == '\r') escaped += "\\r";
        else if (c == '\t') escaped += "\\t";
        else escaped += c;
    }
    return escaped;
}

static std::string typeToString(Type t) {
    switch (t) {
        case Type::Number: return "number";
        case Type::String: return "string";
        case Type::Bool: return "bool";
        default: return "unknown";
    }
}

static std::string valueToJson(const Value& v) {
    switch (v.type) {
        case Type::Number: 
            return std::to_string(std::get<double>(v.data));
        case Type::String: 
            return "\"" + escapeJson(std::get<std::string>(v.data)) + "\"";
        case Type::Bool: 
            return std::get<bool>(v.data) ? "true" : "false";
        default: 
            return "null";
    }
}

static std::string nodeTypeToJson(const NodeType& nodeType) {
    std::ostringstream json;
    json << "{";
    json << "\"name\":\"" << escapeJson(nodeType.name) << "\",";
    json << "\"version\":\"" << escapeJson(nodeType.version) << "\",";
    json << "\"description\":\"" << escapeJson(nodeType.description) << "\",";
    
    // Inputs
    json << "\"inputs\":[";
    for (size_t i = 0; i < nodeType.inputs.size(); ++i) {
        if (i > 0) json << ",";
        json << "\"" << typeToString(nodeType.inputs[i]) << "\"";
    }
    json << "],";
    
    // Outputs  
    json << "\"outputs\":[";
    for (size_t i = 0; i < nodeType.outputs.size(); ++i) {
        if (i > 0) json << ",";
        json << "\"" << typeToString(nodeType.outputs[i]) << "\"";
    }
    json << "],";
    
    // Parameters
    json << "\"params\":[";
    for (size_t i = 0; i < nodeType.params.size(); ++i) {
        if (i > 0) json << ",";
        const auto& param = nodeType.params[i];
        json << "{";
        json << "\"name\":\"" << escapeJson(param.name) << "\",";
        json << "\"type\":\"" << typeToString(param.type) << "\",";
        json << "\"default\":" << valueToJson(param.defaultValue) << ",";
        json << "\"description\":\"" << escapeJson(param.description) << "\"";
        
        if (!param.enumOptions.empty()) {
            json << ",\"enum\":[";
            for (size_t j = 0; j < param.enumOptions.size(); ++j) {
                if (j > 0) json << ",";
                json << "\"" << escapeJson(param.enumOptions[j]) << "\"";
            }
            json << "]";
        }
        json << "}";
    }
    json << "]";
    
    json << "}";
    return json.str();
}

struct Graph {
    std::unordered_map<int, std::unique_ptr<Node>> nodes;
    std::vector<Edge> edges;
    std::vector<OutputPin> outputs;
    std::unordered_map<std::string, NodeType> registry;
    std::string lastError;

    Graph() { registerBuiltins(); }

    Node* getNode(int id) {
        auto it = nodes.find(id);
        return it == nodes.end() ? nullptr : it->second.get();
    }
    void setError(const std::string& e) { lastError = e; }

    void registerBuiltins() {
        registry["Number"] = NodeType{
            "Number", {}, {Type::Number},
            {ParamSpec{"value", Type::Number, Value::num(0.0), {}, "The numeric value"}},
            "1.0.0", "A constant number node",
            [](Node& n, std::string&)->bool {
                double v = 0.0;
                auto it = n.params.find("value");
                if (it != n.params.end() && it->second.type == Type::Number) v = std::get<double>(it->second.data);
                n.outputValues.assign(1, Value::num(v));
                return true;
            }
        };
        registry["String"] = NodeType{
            "String", {}, {Type::String},
            {ParamSpec{"text", Type::String, Value::str(""), {}, "The string value"}},
            "1.0.0", "A constant string node",
            [](Node& n, std::string&)->bool {
                std::string s;
                auto it = n.params.find("text");
                if (it != n.params.end() && it->second.type == Type::String) s = std::get<std::string>(it->second.data);
                n.outputValues.assign(1, Value::str(std::move(s)));
                return true;
            }
        };
        registry["Add"] = NodeType{
            "Add", {Type::Number, Type::Number}, {Type::Number},
            {}, // no parameters
            "1.0.0", "Adds two numbers together",
            [](Node& n, std::string& err)->bool {
                if (n.inputValues.size() != 2 ||
                    n.inputValues[0].type != Type::Number ||
                    n.inputValues[1].type != Type::Number) { err = "Add: invalid inputs"; return false; }
                const double a = std::get<double>(n.inputValues[0].data);
                const double b = std::get<double>(n.inputValues[1].data);
                n.outputValues.assign(1, Value::num(a + b));
                return true;
            }
        };
        registry["Multiply"] = NodeType{
            "Multiply", {Type::Number, Type::Number}, {Type::Number},
            {}, // no parameters
            "1.0.0", "Multiplies two numbers together",
            [](Node& n, std::string& err)->bool {
                if (n.inputValues.size() != 2 ||
                    n.inputValues[0].type != Type::Number ||
                    n.inputValues[1].type != Type::Number) { err = "Multiply: invalid inputs"; return false; }
                const double a = std::get<double>(n.inputValues[0].data);
                const double b = std::get<double>(n.inputValues[1].data);
                n.outputValues.assign(1, Value::num(a * b));
                return true;
            }
        };
        registry["ToString"] = NodeType{
            "ToString", {Type::Number}, {Type::String},
            {}, // no parameters
            "1.0.0", "Converts a number to string",
            [](Node& n, std::string& err)->bool {
                if (n.inputValues.size() != 1 || n.inputValues[0].type != Type::Number) { err = "ToString: invalid input"; return false; }
                std::ostringstream os; os << std::get<double>(n.inputValues[0].data);
                n.outputValues.assign(1, Value::str(os.str()));
                return true;
            }
        };
        registry["Concat"] = NodeType{
            "Concat", {Type::String, Type::String}, {Type::String},
            {}, // no parameters
            "1.0.0", "Concatenates two strings",
            [](Node& n, std::string& err)->bool {
                if (n.inputValues.size() != 2 ||
                    n.inputValues[0].type != Type::String ||
                    n.inputValues[1].type != Type::String) { err = "Concat: invalid inputs"; return false; }
                const auto& a = std::get<std::string>(n.inputValues[0].data);
                const auto& b = std::get<std::string>(n.inputValues[1].data);
                n.outputValues.assign(1, Value::str(a + b));
                return true;
            }
        };
        registry["OutputNumber"] = NodeType{
            "OutputNumber", {Type::Number}, {Type::Number},
            {}, // no parameters
            "1.0.0", "Outputs a number value",
            [](Node& n, std::string& err)->bool {
                if (n.inputValues.size() != 1 || n.inputValues[0].type != Type::Number) { err = "OutputNumber expects Number"; return false; }
                n.outputValues.assign(1, n.inputValues[0]);
                return true;
            }
        };
        registry["OutputString"] = NodeType{
            "OutputString", {Type::String}, {Type::String},
            {}, // no parameters
            "1.0.0", "Outputs a string value",
            [](Node& n, std::string& err)->bool {
                if (n.inputValues.size() != 1 || n.inputValues[0].type != Type::String) { err = "OutputString expects String"; return false; }
                n.outputValues.assign(1, n.inputValues[0]);
                return true;
            }
        };
    }
};

// helper for type conversions
static eng::Type fromC(eng_type_t t) {
    switch (t) {
        case ENG_TYPE_NUMBER: return eng::Type::Number;
        case ENG_TYPE_STRING: return eng::Type::String;
        case ENG_TYPE_BOOL:   return eng::Type::Bool;
    }
    return eng::Type::Number;
}
static eng_type_t toC(eng::Type t) {
    switch (t) {
        case eng::Type::Number: return ENG_TYPE_NUMBER;
        case eng::Type::String: return ENG_TYPE_STRING;
        case eng::Type::Bool:   return ENG_TYPE_BOOL;
    }
    return ENG_TYPE_NUMBER;
}

// Build inputs mapping and verify DAG (Kahn)
static bool build_schedule(eng::Graph& g,
                           std::unordered_map<int, std::vector<std::pair<int,int>>>& inputs,
                           std::string& err_out) {
    std::unordered_map<int, int> indeg;
    std::unordered_map<int, std::vector<eng::Edge>> fanout;
    indeg.reserve(g.nodes.size());

    for (auto& kv : g.nodes) indeg[kv.first] = 0;
    for (const auto& e : g.edges) {
        fanout[e.fromNode].push_back(e);
        indeg[e.toNode]++;
        // Build inputs map by target slot
        auto& vec = inputs[e.toNode];
        if ((int)vec.size() <= e.toIn) vec.resize(e.toIn + 1, {-1,-1});
        vec[e.toIn] = { e.fromNode, e.fromOut };
    }

    // Kahn
    std::vector<int> q;
    for (auto& kv : indeg) if (kv.second == 0) q.push_back(kv.first);
    for (size_t i = 0; i < q.size(); ++i) {
        int u = q[i];
        for (auto& e : fanout[u]) if (--indeg[e.toNode] == 0) q.push_back(e.toNode);
    }
    // cycle?
    for (auto& kv : indeg) if (kv.second != 0) {
        err_out = "Cycle detected in graph";
        return false;
    }
    return true;
}

// Taskflow-powered execution.
// Runs node tasks in parallel with precedence constraints.
static bool runGraphTaskflow(eng::Graph& g) {
    // Prepare default input/output buffers
    for (auto& kv : g.nodes) {
        auto* n = kv.second.get();
        n->inputValues.assign(n->type->inputs.size(), eng::Value::num(0.0));
        n->outputValues.clear();
    }

    // Build inputs mapping and verify DAG
    std::unordered_map<int, std::vector<std::pair<int,int>>> inputs;
    std::string schedule_err;
    if (!build_schedule(g, inputs, schedule_err)) {
        g.setError(schedule_err);
        return false;
    }

    tf::Taskflow tf;
    tf::Executor ex;
    std::unordered_map<int, tf::Task> tmap;
    tmap.reserve(g.nodes.size());

    std::mutex err_mtx;
    bool failed = false;

    // Create one task per node
    for (auto& kv : g.nodes) {
        const int id = kv.first;
        auto task = tf.emplace([&, id]() {
            if (failed) return; // cheap cancellation

            eng::Node* n = g.getNode(id);

            // Pull inputs from upstream outputs according to mapping
            auto it = inputs.find(id);
            if (it != inputs.end()) {
                auto& map = it->second;
                n->inputValues.resize(map.size());
                for (size_t i = 0; i < map.size(); ++i) {
                    auto [src, sout] = map[i];
                    if (src < 0) continue;
                    eng::Node* up = g.getNode(src);
                    if (!up || sout < 0 || sout >= (int)up->outputValues.size()) {
                        std::lock_guard<std::mutex> lk(err_mtx);
                        if (!failed) { g.setError("Dangling edge or output index OOB"); failed = true; }
                        return;
                    }
                    n->inputValues[i] = up->outputValues[sout];
                }
            }

            // Compute
            std::string err;
            if (!n->type->compute(*n, err)) {
                std::lock_guard<std::mutex> lk(err_mtx);
                if (!failed) { g.setError(n->type->name + " compute failed: " + err); failed = true; }
            }
        }).name(std::string("N") + std::to_string(id));

        tmap.emplace(id, std::move(task));
    }

    // Wire precedences (edges)
    for (const auto& e : g.edges) {
        auto itA = tmap.find(e.fromNode);
        auto itB = tmap.find(e.toNode);
        if (itA != tmap.end() && itB != tmap.end()) {
            itA->second.precede(itB->second);
        }
    }

    std::cout << "Running the graph mfa neighbour!!" << std::endl;
    ex.run(tf).wait();

    if (failed) return false;
    return true;
}

} // namespace eng

// ========= C API =========
using Graph    = eng::Graph;
using Node     = eng::Node;
using NodeType = eng::NodeType;
using Value    = eng::Value;

static Graph* as(engine_graph_t g) { return reinterpret_cast<Graph*>(g); }

extern "C" {

engine_graph_t engine_graph_create(void) {
    try { return reinterpret_cast<engine_graph_t>(new Graph()); }
    catch (...) { eng::c_error("engine_graph_create: OOM"); return nullptr; }
}

void engine_graph_destroy(engine_graph_t g) { delete as(g); }

int engine_graph_add_node_with_id(engine_graph_t g, int node_id, const char* type, const char* name) {
    if (!g || !type) { eng::c_error("add_node: null args"); return 1; }
    Graph* gr = as(g);
    if (gr->nodes.count(node_id)) { eng::c_error("add_node: duplicate id"); return 2; }
    auto it = gr->registry.find(type);
    if (it == gr->registry.end()) {
        eng::c_error(std::string("add_node: unknown type '") + type + "'");
        return 3;
    }
    auto n = std::make_unique<Node>();
    n->id = node_id; n->type = &it->second; if (name) n->name = name;
    n->inputValues.assign(n->type->inputs.size(), Value::num(0.0));
    gr->nodes[node_id] = std::move(n);
    return 0;
}

int engine_graph_set_param_number(engine_graph_t g, int node_id, const char* key, double value) {
    if (!g || !key) { eng::c_error("set_param_number: null args"); return 1; }
    Graph* gr = as(g);
    Node* n = gr->getNode(node_id);
    if (!n) { eng::c_error("set_param_number: unknown node"); return 2; }
    n->params[key] = Value::num(value);
    return 0;
}
int engine_graph_set_param_string(engine_graph_t g, int node_id, const char* key, const char* value) {
    if (!g || !key || !value) { eng::c_error("set_param_string: null args"); return 1; }
    Graph* gr = as(g);
    Node* n = gr->getNode(node_id);
    if (!n) { eng::c_error("set_param_string: unknown node"); return 2; }
    n->params[key] = Value::str(value);
    return 0;
}
int engine_graph_set_param_bool(engine_graph_t g, int node_id, const char* key, int value) {
    if (!g || !key) { eng::c_error("set_param_bool: null args"); return 1; }
    Graph* gr = as(g);
    Node* n = gr->getNode(node_id);
    if (!n) { eng::c_error("set_param_bool: unknown node"); return 2; }
    n->params[key] = Value::boolean(!!value);
    return 0;
}

int engine_graph_connect(engine_graph_t g, int from_node, int from_output_idx, int to_node, int to_input_idx) {
    if (!g) { eng::c_error("connect: null graph"); return 1; }
    Graph* gr = as(g);
    Node* a = gr->getNode(from_node);
    Node* b = gr->getNode(to_node);
    if (!a || !b) { eng::c_error("connect: unknown node id"); return 2; }
    if (from_output_idx < 0 || from_output_idx >= (int)a->type->outputs.size()) { eng::c_error("connect: from_out OOB"); return 3; }
    if (to_input_idx   < 0 || to_input_idx   >= (int)b->type->inputs.size()) { eng::c_error("connect: to_in OOB"); return 4; }
    auto outT = a->type->outputs[from_output_idx];
    auto inT  = b->type->inputs[to_input_idx];
    if (outT != inT) { eng::c_error("connect: socket type mismatch"); return 5; }
    gr->edges.push_back({from_node, from_output_idx, to_node, to_input_idx});
    return 0;
}

int engine_graph_add_output(engine_graph_t g, int node_id, int out_index) {
    if (!g) { eng::c_error("add_output: null graph"); return 1; }
    Graph* gr = as(g);
    Node* n = gr->getNode(node_id);
    if (!n) { eng::c_error("add_output: unknown node id"); return 2; }
    if (out_index < 0 || out_index >= (int)n->type->outputs.size()) { eng::c_error("add_output: out_index OOB"); return 3; }
    gr->outputs.push_back({node_id, out_index});
    return 0;
}

int engine_graph_run(engine_graph_t g) {
    if (!g) { eng::c_error("run: null graph"); return 1; }
    Graph* gr = as(g);
    if (!eng::runGraphTaskflow(*gr)) {
        eng::c_error(gr->lastError.empty() ? "execution failed" : gr->lastError);
        return 2;
    }
    return 0;
}

int engine_graph_get_output_count(engine_graph_t g) {
    Graph* gr = as(g);
    return (int)gr->outputs.size();
}

eng_type_t engine_graph_get_output_type(engine_graph_t g, int index) {
    Graph* gr = as(g);
    if (index < 0 || index >= (int)gr->outputs.size()) return ENG_TYPE_NUMBER;
    auto out = gr->outputs[index];
    Node* n = gr->getNode(out.node);
    if (!n) return ENG_TYPE_NUMBER;
    if (out.outIdx < 0 || out.outIdx >= (int)n->outputValues.size()) return ENG_TYPE_NUMBER;
    return eng::toC(n->outputValues[out.outIdx].type);
}

int engine_graph_get_output_number(engine_graph_t g, int index, double* out) {
    if (!g || !out) return 1;
    Graph* gr = as(g);
    if (index < 0 || index >= (int)gr->outputs.size()) return 2;
    auto pin = gr->outputs[index];
    Node* n = gr->getNode(pin.node);
    if (!n) return 3;
    if (pin.outIdx < 0 || pin.outIdx >= (int)n->outputValues.size()) return 4;
    const auto& v = n->outputValues[pin.outIdx];
    if (v.type != eng::Type::Number) return 5;
    *out = std::get<double>(v.data);
    return 0;
}

int engine_graph_get_output_bool(engine_graph_t g, int index, int* out) {
    if (!g || !out) return 1;
    Graph* gr = as(g);
    if (index < 0 || index >= (int)gr->outputs.size()) return 2;
    auto pin = gr->outputs[index];
    Node* n = gr->getNode(pin.node);
    if (!n) return 3;
    if (pin.outIdx < 0 || pin.outIdx >= (int)n->outputValues.size()) return 4;
    const auto& v = n->outputValues[pin.outIdx];
    if (v.type != eng::Type::Bool) return 5;
    *out = std::get<bool>(v.data) ? 1 : 0;
    return 0;
}

const char* engine_graph_get_output_string(engine_graph_t g, int index) {
    Graph* gr = as(g);
    if (index < 0 || index >= (int)gr->outputs.size()) return nullptr;
    auto pin = gr->outputs[index];
    Node* n = gr->getNode(pin.node);
    if (!n) return nullptr;
    if (pin.outIdx < 0 || pin.outIdx >= (int)n->outputValues.size()) return nullptr;
    const auto& v = n->outputValues[pin.outIdx];
    if (v.type != eng::Type::String) return nullptr;
    static thread_local std::string s;
    s = std::get<std::string>(v.data);
    return s.c_str();
}

const char* engine_last_error(void) { return eng::g_last_error.c_str(); }

const char* engine_list_types(void) {
    static thread_local std::string typesList;
    // Create a simple global registry for access without a graph instance
    static std::once_flag registryInitialized;
    static std::unordered_map<std::string, NodeType> globalRegistry;
    
    std::call_once(registryInitialized, []() {
        Graph tempGraph; // This will call registerBuiltins()
        globalRegistry = tempGraph.registry;
    });
    
    std::ostringstream json;
    json << "[";
    bool first = true;
    for (const auto& pair : globalRegistry) {
        if (!first) json << ",";
        json << "\"" << eng::escapeJson(pair.first) << "\"";
        first = false;
    }
    json << "]";
    
    typesList = json.str();
    return typesList.c_str();
}

const char* engine_get_type_spec(const char* typeName) {
    if (!typeName) { 
        eng::c_error("engine_get_type_spec: null typeName"); 
        return nullptr; 
    }
    
    static thread_local std::string typeSpec;
    // Create a simple global registry for access without a graph instance
    static std::once_flag registryInitialized;
    static std::unordered_map<std::string, NodeType> globalRegistry;
    
    std::call_once(registryInitialized, []() {
        Graph tempGraph; // This will call registerBuiltins()
        globalRegistry = tempGraph.registry;
    });
    
    auto it = globalRegistry.find(typeName);
    if (it == globalRegistry.end()) {
        eng::c_error(std::string("engine_get_type_spec: unknown type '") + typeName + "'");
        return nullptr;
    }
    
    typeSpec = eng::nodeTypeToJson(it->second);
    return typeSpec.c_str();
}

} // extern "C"
