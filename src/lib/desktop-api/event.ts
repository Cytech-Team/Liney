import {desktop} from "../electron-bridge";
export type Event<T=unknown>={event:string;payload:T};
export async function listen<T=unknown>(name:string,callback:(event:Event<T>)=>void):Promise<()=>void> {
  return desktop().onEvent((packet)=>{if(packet.name===name)callback({event:name,payload:packet.payload as T});});
}
export function emitTo(label:string,name:string,payload?:unknown):Promise<boolean> {
  return desktop().emit(label,name,payload);
}
