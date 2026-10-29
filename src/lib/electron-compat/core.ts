import {desktop} from "../electron-bridge";
export function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T> {
  return desktop().invoke<T>(command,args);
}
