#include "engine_api.h"
#include <iostream>

extern "C" void engine_set_value(int value) {
    std::cout << "Engine value set to " << value << std::endl;
}
