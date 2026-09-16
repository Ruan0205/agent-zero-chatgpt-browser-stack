import { store as attachmentsStore } from "/components/chat/attachments/attachmentsStore.js";
import { cleanStepTitle, drawProcessStep } from "/js/messages.js";

const STYLE_ID='chatgpt-browser-media-style';
export default async function register(extData) {
  if(extData?.tool_name==='chatgpt_browser_media') { ensureStyles(); extData.handler=drawMedia; }
}
function ensureStyles(){
  if(document.getElementById(STYLE_ID)) return;
  const style=document.createElement('style'); style.id=STYLE_ID;
  style.textContent=`.cgb-media{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,520px));gap:.75rem;padding:.75rem 0}.cgb-media img{width:100%;max-height:70vh;object-fit:contain;border-radius:.75rem;cursor:zoom-in;background:#ffffff0a}.cgb-file{display:flex;align-items:center;gap:.8rem;padding:1rem;border:1px solid #ffffff24;border-radius:.75rem;cursor:pointer;background:#ffffff08}.cgb-file img{width:44px;height:44px;object-fit:contain}.cgb-file span{overflow-wrap:anywhere}`;
  document.head.appendChild(style);
}
function drawMedia({id,heading,content,kvps={},...rest}){
  const log=arguments[0], display={...kvps};
  const attachments=Array.isArray(display.attachments)?display.attachments.filter(x=>typeof x==='string'):[];
  delete display._tool_name; delete display.attachments; delete display.media_paths;
  const result=drawProcessStep({id,title:cleanStepTitle(heading),code:'FILE',classes:['chatgpt-browser-media-step'],kvps:display,content,actionButtons:[],log,...rest});
  if(!attachments.length) return result;
  const gallery=document.createElement('div'); gallery.className='cgb-media';
  for(const attachment of attachments){
    const info=attachmentsStore.getAttachmentDisplayInfo(attachment);
    if(info.isImage){ const img=document.createElement('img'); img.src=info.previewUrl; img.alt=info.filename; img.loading='eager'; img.onclick=info.clickHandler; gallery.appendChild(img); }
    else { const card=document.createElement('button'); card.type='button'; card.className='cgb-file'; const icon=document.createElement('img'); icon.src=info.previewUrl; const label=document.createElement('span'); label.textContent=`${info.filename} (${info.extension})`; card.append(icon,label); card.onclick=info.clickHandler; gallery.appendChild(card); }
  }
  result.detail.appendChild(gallery); return result;
}
