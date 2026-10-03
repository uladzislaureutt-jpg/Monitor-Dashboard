const button=document.getElementById("send");
const status=document.getElementById("status");

function extractArticle(){
  const pick=(selector,attr="content")=>{
    const el=document.querySelector(selector);
    return el?.getAttribute(attr)?.trim()||"";
  };
  const title=pick('meta[property="og:title"]')||pick('meta[name="twitter:title"]')||document.querySelector("h1")?.textContent?.trim()||document.title.trim();
  const source=pick('meta[property="og:site_name"]')||pick('meta[name="application-name"]')||location.hostname.replace(/^www\./,"");
  const bodyText=(document.body?.innerText||"").toLowerCase();
  const paywallMarkers=["paywall","subscription","subscriber only","только для подписчиков","доступ по подписке","оформить подписку","материал доступен по подписке","па падпісцы"];
  const quality=paywallMarkers.some(marker=>bodyText.includes(marker))?"partial":"full";
  const root=document.querySelector("article")||document.querySelector("main")||document.querySelector('[role="main"]')||document.body;
  const clone=root.cloneNode(true);
  clone.querySelectorAll("script,style,noscript,svg,nav,aside,footer,form,button,iframe,.advert,.advertisement,.ads,.social,.share,.comments").forEach(el=>el.remove());
  const parts=[...clone.querySelectorAll("p,li")].map(el=>el.textContent.replace(/\s+/g," ").trim()).filter(text=>text.length>=25);
  let text=parts.join("\n\n").replace(/\n{3,}/g,"\n\n").trim();
  if(text.length<200){
    text=clone.innerText.replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
  }
  return {title,source,url:location.href,text,quality};
}

async function send(){
  button.disabled=true;
  status.className="";
  status.textContent="Извлекаю текст…";
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id) throw new Error("Активная вкладка не найдена.");
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractArticle});
    if(!result?.title||!result?.text||result.text.length<80) throw new Error("Не удалось выделить текст публикации.");
    status.textContent="Передаю в Monitor…";
    const response=await fetch("http://127.0.0.1:17842/import",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Monitor-Browser-Import":"1"},
      body:JSON.stringify(result)
    });
    if(!response.ok) throw new Error("Monitor не принял материал.");
    status.className="ok";
    status.textContent="Готово. Вернитесь в Monitor и нажмите «Получить из браузера».";
  }catch(error){
    status.className="err";
    status.textContent=String(error?.message||error);
  }finally{button.disabled=false;}
}
button.addEventListener("click",send);
