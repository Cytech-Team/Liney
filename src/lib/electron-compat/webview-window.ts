import {desktop} from "../electron-bridge";
type Opts={url?:string;title?:string;width?:number;height?:number;minWidth?:number;minHeight?:number;center?:boolean;resizable?:boolean};
export class WebviewWindow {
  private label:string;
  constructor(label:string,options:Opts) {
    this.label=label;
    this.ready=desktop().window("create",label,{...options,query:options.url?.split("?")[1]||""});
  }
  private ready:Promise<boolean>;
  static async getByLabel(_label:string):Promise<WebviewWindow|null> {
    // Reopening via create() is safe; a duplicate is not created.
    return null;
  }
  once(event:string,callback:()=>void) {
    if(event==="tauri://created")void this.ready.then(()=>callback());
  }
  show(){return desktop().window("show",this.label);}
  setFocus(){return desktop().window("focus",this.label);}
}
