const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const website=path.resolve(__dirname,'..');
const bootstrap=fs.readFileSync(path.join(website,'theme-init.js'),'utf8');
const controller=fs.readFileSync(path.join(website,'site.js'),'utf8');

class Element {
  constructor(tag='div'){
    this.tagName=tag.toUpperCase(); this.attributes={}; this.listeners={};
    this.children=[]; this.style={}; this.textContent=''; this.hidden=false;
    this.classes=new Set(); this.classList={
      add:(s)=>this.classes.add(s),
      remove:(s)=>this.classes.delete(s),
      toggle:(s,value)=>{const v=value===undefined?!this.classes.has(s):value; v?this.classes.add(s):this.classes.delete(s);return v;},
      contains:(s)=>this.classes.has(s)
    };
  }
  set className(value){this.classes=new Set(String(value).split(/\s+/).filter(Boolean));}
  get className(){return [...this.classes].join(' ');}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  removeAttribute(k){delete this.attributes[k];}
  appendChild(c){this.children.push(c);c.parent=this;return c;}
  querySelector(sel){return this.children.find(c=>sel==='.theme-picker'&&c.classes.has('theme-picker'))||null;}
  addEventListener(k,callback){(this.listeners[k]??=[]).push(callback);}
  fire(k,event={}){for(const f of this.listeners[k]||[])f(event);}
  contains(child){for(let node=child;node;node=node.parent){if(node===this)return true;}return false;}
  focus(){this.focused=true;}
}
function createEnvironment(stored, dark=false, blockedStorage=false) {
  const attrs={};const root=new Element('html');const headMeta=new Element('meta');
  const shell=new Element('div');shell.classes.add('nav-shell');
  const storage=new Map(stored===null?[]:[['liney.site.theme',stored]]);
  let mediaCallback=null; let matches=dark;
  const media={get matches(){return matches;},addEventListener:(type,cb)=>{if(type==='change')mediaCallback=cb}};
  const document={
    documentElement:root, createElement:(name)=>new Element(name),listeners:{},
    querySelector:(sel)=>{
      if(sel==='meta[name="theme-color"]')return headMeta;
      if(sel==='.nav-shell')return shell;
      return null;
    },
    querySelectorAll:()=>[],
    addEventListener(name,callback){(this.listeners[name]??=[]).push(callback);},
    fire(name,e){for(const f of this.listeners[name]||[])f(e)}
  };
  const window={
    LINEY_SITE_CONFIG:{},
    matchMedia:()=>media,
    location:{hostname:'liney.namnarak.in.th',pathname:'/'},
    localStorage:{
      getItem:(key)=>{if(blockedStorage)throw Error('denied');return storage.get(key)||null;},
      setItem:(key,value)=>{if(blockedStorage)throw Error('denied');storage.set(key,value);}
    }
  };
  return {document,window,root,headMeta,shell,storage,changeSystem(value){matches=value;if(mediaCallback)mediaCallback({matches:value});}};
}
function init(env){
  vm.runInNewContext(bootstrap,{window:env.window,document:env.document});
  vm.runInNewContext(controller,{window:env.window,document:env.document,URL,Date});
  const picker=env.shell.children.find(c=>c.classes.has('theme-picker'));
  assert.ok(picker,'theme picker exists');
  const trigger=picker.children[0],menu=picker.children[1];
  const options=Object.fromEntries(menu.children.map(n=>[n.getAttribute('data-theme-option'),n]));
  return {trigger,menu,options};
}
test('system default responds to OS, without preference storage',()=>{
  const env=createEnvironment(null,true);const ui=init(env);
  assert.equal(env.root.getAttribute('data-theme'),'dark');
  assert.equal(ui.options.system.getAttribute('aria-pressed'),'true');
  assert.equal(env.headMeta.getAttribute('content'),'#101815');
  env.changeSystem(false);
  assert.equal(env.root.getAttribute('data-theme'),'light');
  assert.equal(env.headMeta.getAttribute('content'),'#f6f7f2');
});
test('explicit saved theme overrides OS and persists changes',()=>{
  const env=createEnvironment('dark',false);const ui=init(env);
  assert.equal(env.root.getAttribute('data-theme'),'dark');
  ui.trigger.fire('click');assert.equal(ui.menu.hidden,false);
  ui.options.light.fire('click');
  assert.equal(env.root.getAttribute('data-theme'),'light');
  assert.equal(env.storage.get('liney.site.theme'),'light');
  assert.equal(ui.menu.hidden,true);
  assert.equal(ui.options.light.getAttribute('aria-pressed'),'true');
  env.changeSystem(true);
  assert.equal(env.root.getAttribute('data-theme'),'light');
  ui.trigger.fire('click');
  ui.options.system.fire('click');
  assert.equal(env.root.getAttribute('data-theme'),'dark');
  assert.equal(env.storage.get('liney.site.theme'),'system');
});
test('storage restrictions do not block theme selection',()=>{
  const env=createEnvironment(null,true,true);const ui=init(env);
  ui.trigger.fire('click');ui.options.light.fire('click');
  assert.equal(env.root.getAttribute('data-theme'),'light');
});
test('escape and outside click dismiss menu',()=>{
  const env=createEnvironment(null);const ui=init(env);
  ui.trigger.fire('click');assert.equal(ui.menu.hidden,false);
  env.document.fire('keydown',{key:'Escape'});
  assert.equal(ui.menu.hidden,true);assert.equal(ui.trigger.focused,true);
  ui.trigger.fire('click');env.document.fire('click',{target:new Element('aside')});
  assert.equal(ui.menu.hidden,true);
});
