const container = document.getElementById('rete');

const numSocket = new Rete.Socket('Number');

class NumControl extends Rete.Control {
  constructor(emitter, key) {
    super(key);
    this.render = 'js';
    this.key = key;
    this.emitter = emitter;
    this.component = {
      props: ['emitter', 'ikey', 'getData', 'putData'],
      template: '<input type="number" :value="getData(ikey)" @input="change($event)"/>' ,
      methods: {
        change(e) {
          this.putData(this.ikey, +e.target.value);
          this.emitter.trigger('process');
        }
      }
    };
    this.props = { emitter, ikey: key };
  }
  setValue(val) {
    this.vueContext.putData(this.key, val);
    this.update();
  }
}

class NumberComponent extends Rete.Component {
  constructor() { super('Number'); }
  builder(node) {
    let ctrl = new NumControl(this.editor, 'num');
    let out = new Rete.Output('num', 'Number', numSocket);
    return node.addControl(ctrl).addOutput(out);
  }
  worker(node, inputs, outputs) {
    const val = node.data.num || 0;
    outputs['num'] = val;
    fetch('/set?value=' + val);
  }
}

(async () => {
  const editor = new Rete.NodeEditor('demo@0.1.0', container);
  editor.use(ConnectionPlugin.default);
  editor.use(VueRenderPlugin.default);
  const engine = new Rete.Engine('demo@0.1.0');
  const comp = new NumberComponent();
  editor.register(comp);
  engine.register(comp);
  const node = await comp.createNode({ num: 0 });
  node.position = [80, 200];
  editor.addNode(node);
  editor.on('process nodecreated noderemoved connectioncreated connectionremoved', async () => {
    await engine.abort();
    await engine.process(editor.toJSON());
  });
  editor.trigger('process');
})();
