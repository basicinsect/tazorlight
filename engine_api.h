#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* engine_graph_t;

typedef enum {
    ENG_TYPE_NUMBER = 0,
    ENG_TYPE_STRING = 1,
    ENG_TYPE_BOOL   = 2
} eng_type_t;

engine_graph_t engine_graph_create(void);
void           engine_graph_destroy(engine_graph_t g);

int engine_graph_add_node_with_id(engine_graph_t g,
                                  int node_id,
                                  const char* type,
                                  const char* name);

int engine_graph_set_param_number(engine_graph_t g, int node_id, const char* key, double value);
int engine_graph_set_param_string(engine_graph_t g, int node_id, const char* key, const char* value);
int engine_graph_set_param_bool  (engine_graph_t g, int node_id, const char* key, int value);

int engine_graph_connect(engine_graph_t g,
                         int from_node, int from_output_idx,
                         int to_node,   int to_input_idx);

int engine_graph_add_output(engine_graph_t g, int node_id, int out_index);

int engine_graph_run(engine_graph_t g);

int         engine_graph_get_output_count(engine_graph_t g);
eng_type_t  engine_graph_get_output_type (engine_graph_t g, int index);
int         engine_graph_get_output_number(engine_graph_t g, int index, double* out);
int         engine_graph_get_output_bool  (engine_graph_t g, int index, int* out);
const char* engine_graph_get_output_string(engine_graph_t g, int index);

const char* engine_last_error(void);

#ifdef __cplusplus
}
#endif
