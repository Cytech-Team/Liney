import {desktop} from "../electron-bridge";
export function getCurrentWindow() {
  const label=new URLSearchParams(window.location.search).has("liney-view")?"image-viewer":"main";
  return {
    show:()=>desktop().window("show",label),
    setFocus:()=>desktop().window("focus",label),
    close:()=>desktop().window("close",label)
  };
}
