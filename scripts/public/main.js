(async function () {
  const container = document.getElementById('rete');
  const resultsEl = document.getElementById('results');

  if (!window.Rete || typeof Rete.NodeEditor !== 'function') {
    throw new Error('Rete v1 core not loaded (check rete@1.4.4 script tag).');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve(src);
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function resolveUMD(candidates) {
    for (const key of candidates) {
      const raw = window[key];
      if (!raw) continue;
      const obj = raw.install ? raw : (raw.default && raw.default.install ? raw.default : null);
      if (obj && typeof obj.install === 'function') return obj;
    }
    return null;
  }

  async function ensurePlugin(label, globals, urls) {
    let obj = resolveUMD(globals);
    if (obj) return obj;

    let lastErr;
    for (const url of urls) {
      try {
        await loadScript(url);
        obj = resolveUMD(globals);
        if (obj) return obj;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`${label} not loaded. Tried:\n${urls.join('\n')}\n${lastErr ? lastErr.message : ''}`);
  }

  // Load v1 plugins with fallbacks (unpkg → jsDelivr)
  const ConnectionPlugin = await ensurePlugin(
    'rete-connection-plugin v0.9 UMD',
    ['ConnectionPlugin', 'ReteConnectionPlugin', 'connectionPlugin'],
    [
      'https://unpkg.com/rete-connection-plugin@0.9.0/build/connection-plugin.min.js',
      'https://cdn.jsdelivr.net/npm/rete-connection-plugin@0.9.0/build/connection-plugin.min.js'
    ]
  );

  const VueRenderPlugin = await ensurePlugin(
    'rete-vue-render-plugin v0.5 UMD',
    ['VueRenderPlugin', 'ReteVueRenderPlugin', 'vueRenderPlugin'],
    [
      'https://unpkg.com/rete-vue-render-plugin@0.5.2/build/vue-render-plugin.min.js',
      'https://cdn.jsdelivr.net/npm/rete-vue-render-plugin@0.5.2/build/vue-render-plugin.min.js'
    ]
  );

  // --- sockets ---
  const sockets = {};
  function getSocket(type) {
    if (!sockets[type]) {
      sockets[type] = new Rete.Socket(type);
    }
    return sockets[type];
  }
  
  // Create standard sockets
  const numSocket = getSocket('number');
  const strSocket = getSocket('string');
  const boolSocket = getSocket('bool');

  // --- dynamic controls ---
  class DynamicControl extends Rete.Control {
    constructor(emitter, key, paramSpec) {
      super(key);
      this.render = 'vue';
      this.key = key;
      this.emitter = emitter;
      this.paramSpec = paramSpec;
      
      let template, inputHandler;
      const initial = this.getInitialValue();
      
      if (paramSpec.type === 'number') {
        template = `<input type="number" :value="getData(ikey) ?? ${initial}" @input="change($event)" style="width:100px"/>`;
        inputHandler = (e) => +e.target.value;
      } else if (paramSpec.type === 'bool') {
        template = `<input type="checkbox" :checked="getData(ikey) ?? ${initial}" @change="change($event)"/>`;
        inputHandler = (e) => e.target.checked;
      } else if (paramSpec.enum && paramSpec.enum.length > 0) {
        const options = paramSpec.enum.map(opt => `<option value="${opt}">${opt}</option>`).join('');
        template = `<select :value="getData(ikey) ?? '${initial}'" @change="change($event)" style="width:120px"><option value="">[Select]</option>${options}</select>`;
        inputHandler = (e) => e.target.value;
      } else {
        // string or unknown - default to text
        template = `<input type="text" :value="getData(ikey) ?? '${initial}'" @input="change($event)" style="width:160px"/>`;
        inputHandler = (e) => e.target.value;
      }
      
      this.component = {
        props: ['emitter', 'ikey', 'getData', 'putData'],
        template,
        methods: {
          change(e) {
            this.putData(this.ikey, inputHandler(e));
            this.emitter.trigger('process');
          }
        }
      };
      this.props = { emitter, ikey: key };
    }
    
    getInitialValue() {
      const defaultVal = this.paramSpec.default;
      if (this.paramSpec.type === 'number') return defaultVal || 0;
      if (this.paramSpec.type === 'bool') return defaultVal || false;
      if (this.paramSpec.type === 'string') return defaultVal || '';
      return defaultVal || '';
    }
  }

  // --- dynamic component generator ---
  function createDynamicComponent(typeSpec) {
    return class extends Rete.Component {
      constructor() {
        super(typeSpec.name);
        this.typeSpec = typeSpec;
      }
      
      builder(node) {
        // Add inputs
        typeSpec.inputs.forEach((inputType, index) => {
          const socket = getSocket(inputType);
          const input = new Rete.Input(`in${index}`, `Input ${index + 1}`, socket);
          node.addInput(input);
        });
        
        // Add outputs
        typeSpec.outputs.forEach((outputType, index) => {
          const socket = getSocket(outputType);
          const output = new Rete.Output(`out${index}`, `Output ${index + 1}`, socket);
          node.addOutput(output);
        });
        
        // Add parameter controls
        typeSpec.params.forEach(paramSpec => {
          const ctrl = new DynamicControl(this.editor, paramSpec.name, paramSpec);
          node.addControl(ctrl);
        });
        
        return node;
      }
      
      worker(node, inputs, outputs) {
        // For dynamic components, we don't do local computation since the backend handles it
        // This is just to make Rete.js happy - actual computation happens in the backend
        typeSpec.outputs.forEach((outputType, index) => {
          const outputKey = `out${index}`;
          if (typeSpec.inputs.length === 0) {
            // Parameter-based node (like Number, String)
            if (typeSpec.name === 'Number' && node.data.value !== undefined) {
              outputs[outputKey] = node.data.value;
            } else if (typeSpec.name === 'String' && node.data.text !== undefined) {
              outputs[outputKey] = node.data.text;
            } else {
              outputs[outputKey] = null;
            }
          } else {
            // Input-based node - outputs depend on inputs (handled by backend)
            outputs[outputKey] = null;
          }
        });
      }
    };
  }

  // --- API functions ---
  async function loadNodeTypes() {
    try {
      const response = await fetch('/types');
      if (!response.ok) {
        throw new Error(`Failed to load types: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error loading node types:', error);
      throw error;
    }
  }

  async function loadTypeSpec(typeName) {
    try {
      const response = await fetch(`/types/${typeName}`);
      if (!response.ok) {
        throw new Error(`Failed to load type spec for ${typeName}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`Error loading type spec for ${typeName}:`, error);
      throw error;
    }
  }

  // --- editor + engine setup ---
  const editor = new Rete.NodeEditor('tazor@0.1.0', container);
  editor.use(ConnectionPlugin);
  editor.use(VueRenderPlugin);

  const engine = new Rete.Engine('tazor@0.1.0');

  // Dynamic components storage
  let comps = {};
  let nodeTypes = [];

  // Initialize dynamic components
  async function initializeDynamicComponents() {
    try {
      // Load available node types
      nodeTypes = await loadNodeTypes();
      console.log('Loaded node types:', nodeTypes);
      
      // Load specs and create components for each type
      for (const typeName of nodeTypes) {
        const typeSpec = await loadTypeSpec(typeName);
        console.log(`Loaded spec for ${typeName}:`, typeSpec);
        
        const ComponentClass = createDynamicComponent(typeSpec);
        const component = new ComponentClass();
        comps[typeName] = component;
        
        editor.register(component);
        engine.register(component);
      }
      
      // Generate dynamic palette
      generateDynamicPalette();
      
      console.log('✅ Dynamic components initialized');
    } catch (error) {
      console.error('❌ Failed to initialize dynamic components:', error);
      // Show error to user
      resultsEl.textContent = `Error: Failed to load node types - ${error.message}`;
    }
  }

  // Generate dynamic palette buttons
  function generateDynamicPalette() {
    const toolbar = document.querySelector('.toolbar');
    
    // Remove old hardcoded buttons (except Run button)
    const buttonsToRemove = toolbar.querySelectorAll('button:not(#btn-run)');
    buttonsToRemove.forEach(btn => btn.remove());
    
    // Add dynamic buttons
    nodeTypes.forEach((typeName, index) => {
      const button = document.createElement('button');
      button.textContent = `Add ${typeName}`;
      button.onclick = () => addNode(typeName, getDefaultData(typeName), [80 + (index % 4) * 200, 200 + Math.floor(index / 4) * 60]);
      toolbar.insertBefore(button, toolbar.lastElementChild); // Insert before Run button
    });
  }

  // Get default data for a node type
  function getDefaultData(typeName) {
    const component = comps[typeName];
    if (!component || !component.typeSpec) return {};
    
    const data = {};
    component.typeSpec.params.forEach(param => {
      data[param.name] = param.default;
    });
    return data;
  }

  // quick add helpers
  async function addNode(componentName, data = {}, pos = [80, 80]) {
    const c = comps[componentName];
    if (!c) {
      console.error(`Component ${componentName} not found`);
      return null;
    }
    const n = await c.createNode(data);
    n.position = pos;
    editor.addNode(n);
    return n;
  }

  const process = async () => {
    await engine.abort();
    await engine.process(editor.toJSON());
  };
  
  // Initialize the dynamic system and start processing
  initializeDynamicComponents().then(() => {
    editor.on('process nodecreated noderemoved connectioncreated connectionremoved', process);
    process();
  });

  // export plan for backend - supports both JSON v1 and legacy text format
  function exportPlan(useLegacyFormat = false) {
    const j = editor.toJSON();
    const nodes = j.nodes || {};

    if (useLegacyFormat) {
      // Legacy text format
      const lines = [];
      lines.push(`NODES ${Object.keys(nodes).length}`);

      const outIdxOf = (node, outputKey) => Object.keys(node.outputs).indexOf(outputKey);
      const inIdxOf  = (node, inputKey)  => Object.keys(node.inputs).indexOf(inputKey);

      for (const idStr of Object.keys(nodes)) {
        const id = +idStr;
        const n = nodes[idStr];
        const tail = [];
        
        // Extract parameters from node data based on component spec
        const component = comps[n.name];
        if (component && component.typeSpec && component.typeSpec.params) {
          component.typeSpec.params.forEach(paramSpec => {
            const value = n.data[paramSpec.name];
            if (value !== undefined && value !== null) {
              if (paramSpec.type === 'string') {
                // Handle strings with spaces
                tail.push(`${paramSpec.name}=${String(value).replace(/\s+/g,'_')}`);
              } else {
                tail.push(`${paramSpec.name}=${value}`);
              }
            }
          });
        }
        
        lines.push(`NODE ${id} ${n.name}${tail.length ? ' ' + tail.join(' ') : ''}`);
      }

      for (const idStr of Object.keys(nodes)) {
        const id = +idStr;
        const n = nodes[idStr];
        for (const [inKey, inObj] of Object.entries(n.inputs)) {
          const idxIn = Math.max(0, inIdxOf(n, inKey));
          for (const c of inObj.connections || []) {
            const fromId = c.node;
            const fromNode = nodes[String(fromId)];
            const idxOut = Math.max(0, outIdxOf(fromNode, c.output));
            lines.push(`CONNECTION ${fromId} ${idxOut} ${id} ${idxIn}`);
          }
        }
      }

      for (const idStr of Object.keys(nodes)) {
        const n = nodes[idStr];
        if (n.name === 'OutputNumber' || n.name === 'OutputString') {
          lines.push(`OUTPUT ${+idStr} 0`);
        }
      }

      return lines.join('\n') + '\n';
    }

    // JSON v1 format (default)
    const outIdxOf = (node, outputKey) => Object.keys(node.outputs).indexOf(outputKey);
    const inIdxOf  = (node, inputKey)  => Object.keys(node.inputs).indexOf(inputKey);

    // Build JSON v1 format
    const planNodes = [];
    const dataEdges = [];
    const outputs = [];

    // Process nodes
    for (const idStr of Object.keys(nodes)) {
      const id = +idStr;
      const n = nodes[idStr];
      const params = {};
      
      // Extract parameters from node data based on component spec
      const component = comps[n.name];
      if (component && component.typeSpec && component.typeSpec.params) {
        component.typeSpec.params.forEach(paramSpec => {
          const value = n.data[paramSpec.name];
          if (value !== undefined && value !== null) {
            params[paramSpec.name] = value;
          }
        });
      }
      
      planNodes.push({
        id: id,
        type: n.name,
        params: params
      });
    }

    // Process connections (data edges)
    for (const idStr of Object.keys(nodes)) {
      const id = +idStr;
      const n = nodes[idStr];
      for (const [inKey, inObj] of Object.entries(n.inputs)) {
        const idxIn = Math.max(0, inIdxOf(n, inKey));
        for (const c of inObj.connections || []) {
          const fromId = c.node;
          const fromNode = nodes[String(fromId)];
          const idxOut = Math.max(0, outIdxOf(fromNode, c.output));
          dataEdges.push({
            from: fromId,
            fromOutput: idxOut,
            to: id,
            toInput: idxIn
          });
        }
      }
    }

    // Process outputs
    for (const idStr of Object.keys(nodes)) {
      const n = nodes[idStr];
      if (n.name === 'OutputNumber' || n.name === 'OutputString') {
        outputs.push({
          node: +idStr,
          output: 0
        });
      }
    }

    // Return JSON v1 format
    return JSON.stringify({
      version: 1,
      nodes: planNodes,
      edges: {
        data: dataEdges,
        control: []
      },
      outputs: outputs
    }, null, 2);
  }

  async function runBackend() {
    // Check for legacy format flag (e.g., from URL parameter)
    const urlParams = new URLSearchParams(window.location.search);
    const useLegacy = urlParams.get('legacy') === 'true';
    
    const plan = exportPlan(useLegacy);
    const contentType = useLegacy ? 'text/plain' : 'application/json';
    
    try {
      const r = await fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: plan
      });
      const txt = await r.text();
      resultsEl.textContent = txt;
    } catch (e) {
      resultsEl.textContent = 'Run failed: ' + e;
    }
  }

  document.getElementById('btn-run').onclick = runBackend;

  console.log('✅ Rete v1 loaded. Versions → Rete:', Rete.version);
})();
