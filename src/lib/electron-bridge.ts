export interface LineyDesktopBridge {
  start(): Promise<boolean>;
  request<T>(method:string,params:Record<string,unknown>,timeout:number):Promise<T>;
  stop():Promise<void>;
  onEngine(listener:(event:Record<string,unknown>)=>void):()=>void;
  invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>;
  openDialog(options?:Record<string,unknown>):Promise<string|string[]|null>;
  window(cmd:string,label:string,options?:Record<string,unknown>):Promise<boolean>;
  emit(label:string,name:string,payload?:unknown):Promise<boolean>;
  onEvent(listener:(event:{name:string;payload:unknown})=>void):()=>void;
}
declare global {
  interface Window {lineyDesktop?:LineyDesktopBridge}
}
export const desktop = ():LineyDesktopBridge => {
  if(!window.lineyDesktop) throw new Error("Electron desktop bridge unavailable");
  return window.lineyDesktop;
};
