import {desktop} from "../electron-bridge";
type Opts={url?:string;title?:string;width?:number;height?:number;minWidth?:number;minHeight?:number;center?:boolean;resizable?:boolean};
export class WebviewWindow {
  private label:string;
  private ready:Promise<boolean>;
  constructor(label:string,options:Opts={},create=true) {
    this.label=label;
    this.ready=create
      ? desktop().window("create",label,{...options,query:options.url?.split("?")[1]||""})
      : Promise.resolve(true);
  }
  static async getByLabel(label:string):Promise<WebviewWindow|null> {
    return await desktop().window("exists",label) ? new WebviewWindow(label,{},false) : null;
  }
  once(event:string,callback:()=>void) {
    if(event==="liney:window-created")void this.ready.then(()=>callback());
  }
  show(){return desktop().window("show",this.label);}
  setFocus(){return desktop().window("focus",this.label);}
}
