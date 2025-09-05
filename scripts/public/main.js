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
  const numSocket = new Rete.Socket('Number');
  const strSocket = new Rete.Socket('String');

  // --- controls ---
  class NumControl extends Rete.Control {
    constructor(emitter, key, initial = 0) {
      super(key);
      this.render = 'vue';
      this.key = key;
      this.emitter = emitter;
      this.component = {
        props: ['emitter', 'ikey', 'getData', 'putData'],
        template: `<input type="number" :value="getData(ikey) ?? ${initial}" @input="change($event)" style="width:100px"/>`,
        methods: {
          change(e) {
            this.putData(this.ikey, +e.target.value);
            this.emitter.trigger('process');
          }
        }
      };
      this.props = { emitter, ikey: key };
    }
  }

  class TextControl extends Rete.Control {
    constructor(emitter, key, initial = '') {
      super(key);
      this.render = 'vue';
      this.key = key;
      this.emitter = emitter;
      this.component = {
        props: ['emitter', 'ikey', 'getData', 'putData'],
        template: `<input type="text" :value="getData(ikey) ?? '${initial}'" @input="change($event)" style="width:160px"/>`,
        methods: {
          change(e) {
            this.putData(this.ikey, e.target.value);
            this.emitter.trigger('process');
          }
        }
      };
      this.props = { emitter, ikey: key };
    }
  }

  // --- components ---
  class NumberComponent extends Rete.Component {
    constructor() { super('Number'); }
    builder(node) {
      const out = new Rete.Output('out', 'Number', numSocket);
      const ctrl = new NumControl(this.editor, 'value', 0);
      return node.addControl(ctrl).addOutput(out);
    }
    worker(node, inputs, outputs) {
      outputs['out'] = node.data.value ?? 0;
    }
  }

  class StringComponent extends Rete.Component {
    constructor() { super('String'); }
    builder(node) {
      const out = new Rete.Output('out', 'String', strSocket);
      const ctrl = new TextControl(this.editor, 'text', '');
      return node.addControl(ctrl).addOutput(out);
    }
    worker(node, inputs, outputs) {
      outputs['out'] = node.data.text ?? '';
    }
  }

  class AddComponent extends Rete.Component {
    constructor() { super('Add'); }
    builder(node) {
      const a = new Rete.Input('a', 'A', numSocket);
      const b = new Rete.Input('b', 'B', numSocket);
      const out = new Rete.Output('out', 'Number', numSocket);
      return node.addInput(a).addInput(b).addOutput(out);
    }
    worker(node, inputs, outputs) {
      const A = inputs['a']?.[0] ?? 0;
      const B = inputs['b']?.[0] ?? 0;
      outputs['out'] = (+A) + (+B);
    }
  }

  class MultiplyComponent extends Rete.Component {
    constructor() { super('Multiply'); }
    builder(node) {
      const a = new Rete.Input('a', 'A', numSocket);
      const b = new Rete.Input('b', 'B', numSocket);
      const out = new Rete.Output('out', 'Number', numSocket);
      return node.addInput(a).addInput(b).addOutput(out);
    }
    worker(node, inputs, outputs) {
      const A = inputs['a']?.[0] ?? 0;
      const B = inputs['b']?.[0] ?? 0;
      outputs['out'] = (+A) * (+B);
    }
  }

  class ToStringComponent extends Rete.Component {
    constructor() { super('ToString'); }
    builder(node) {
      const inNum = new Rete.Input('in', 'Number', numSocket);
      const out = new Rete.Output('out', 'String', strSocket);
      return node.addInput(inNum).addOutput(out);
    }
    worker(node, inputs, outputs) {
      const v = inputs['in']?.[0] ?? 0;
      outputs['out'] = String(v);
    }
  }

  class ConcatComponent extends Rete.Component {
    constructor() { super('Concat'); }
    builder(node) {
      const a = new Rete.Input('a', 'A', strSocket);
      const b = new Rete.Input('b', 'B', strSocket);
      const out = new Rete.Output('out', 'String', strSocket);
      return node.addInput(a).addInput(b).addOutput(out);
    }
    worker(node, inputs, outputs) {
      const A = inputs['a']?.[0] ?? '';
      const B = inputs['b']?.[0] ?? '';
      outputs['out'] = String(A) + String(B);
    }
  }

  class OutputNumberComponent extends Rete.Component {
    constructor() { super('OutputNumber'); }
    builder(node) {
      const inp = new Rete.Input('in', 'Number', numSocket);
      const out = new Rete.Output('out', 'Number', numSocket);
      return node.addInput(inp).addOutput(out);
    }
    worker(node, inputs, outputs) {
      outputs['out'] = inputs['in']?.[0] ?? 0;
    }
  }
  class OutputStringComponent extends Rete.Component {
    constructor() { super('OutputString'); }
    builder(node) {
      const inp = new Rete.Input('in', 'String', strSocket);
      const out = new Rete.Output('out', 'String', strSocket);
      return node.addInput(inp).addOutput(out);
    }
    worker(node, inputs, outputs) {
      outputs['out'] = inputs['in']?.[0] ?? '';
    }
  }

  // --- editor + engine ---
  const editor = new Rete.NodeEditor('tazor@0.1.0', container);
  editor.use(ConnectionPlugin);
  editor.use(VueRenderPlugin);

  const engine = new Rete.Engine('tazor@0.1.0');

  const comps = {
    Number: new NumberComponent(),
    String: new StringComponent(),
    Add: new AddComponent(),
    Multiply: new MultiplyComponent(),
    ToString: new ToStringComponent(),
    Concat: new ConcatComponent(),
    OutputNumber: new OutputNumberComponent(),
    OutputString: new OutputStringComponent(),
  };

  Object.values(comps).forEach(c => { editor.register(c); engine.register(c); });

  // quick add helpers
  async function addNode(componentName, data = {}, pos = [80, 80]) {
    const c = comps[componentName];
    const n = await c.createNode(data);
    n.position = pos;
    editor.addNode(n);
    return n;
  }

  document.getElementById('btn-add-number').onclick = () => addNode('Number', { value: 0 }, [80, 200]);
  document.getElementById('btn-add-string').onclick = () => addNode('String', { text: '' }, [80, 220]);
  document.getElementById('btn-add-add').onclick = () => addNode('Add', {}, [320, 200]);
  document.getElementById('btn-add-mul').onclick = () => addNode('Multiply', {}, [320, 260]);
  document.getElementById('btn-add-tostr').onclick = () => addNode('ToString', {}, [560, 220]);
  document.getElementById('btn-add-concat').onclick = () => addNode('Concat', {}, [560, 280]);
  document.getElementById('btn-add-output-num').onclick = () => addNode('OutputNumber', {}, [800, 200]);
  document.getElementById('btn-add-output-str').onclick = () => addNode('OutputString', {}, [800, 260]);

  const process = async () => {
    await engine.abort();
    await engine.process(editor.toJSON());
  };
  editor.on('process nodecreated noderemoved connectioncreated connectionremoved', process);
  process();

  // export plan for backend
  function exportPlan() {
    const j = editor.toJSON();
    const nodes = j.nodes || {};

    const lines = [];
    lines.push(`NODES ${Object.keys(nodes).length}`);

    const outIdxOf = (node, outputKey) => Object.keys(node.outputs).indexOf(outputKey);
    const inIdxOf  = (node, inputKey)  => Object.keys(node.inputs).indexOf(inputKey);

    for (const idStr of Object.keys(nodes)) {
      const id = +idStr;
      const n = nodes[idStr];
      const tail = [];
      if (n.name === 'Number' && typeof n.data.value === 'number') tail.push(`value=${n.data.value}`);
      if (n.name === 'String' && typeof n.data.text === 'string') tail.push(`text=${(n.data.text||'').replace(/\s+/g,'_')}`);
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

  async function runBackend() {
    const plan = exportPlan();
    try {
      const r = await fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
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
