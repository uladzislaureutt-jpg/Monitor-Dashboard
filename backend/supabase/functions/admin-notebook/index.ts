import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}})}
const bucket="monitor-admin-notes";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxImages=6;
type Note={id:string;title:string;body:string;image_paths:string[];created_at:string;updated_at:string};
function cleanNote(note:any):Note{
  return {id:String(note.id),title:String(note.title),body:String(note.body),
    image_paths:Array.isArray(note.image_paths)?note.image_paths.filter((x:unknown)=>typeof x==="string"):[],
    created_at:String(note.created_at),updated_at:String(note.updated_at)};
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 const url=Deno.env.get("SUPABASE_URL")||"";
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const publishable=Deno.env.get("SUPABASE_ANON_KEY")||"";
 if(!url||!service||!publishable)return reply({error:"not_configured"},503);
 const authorization=req.headers.get("Authorization")||"";
 if(!authorization.startsWith("Bearer "))return reply({error:"unauthorized"},401);
 const admin=createClient(url,service,{auth:{persistSession:false}});
 const auth=createClient(url,publishable,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
 const {data:{user},error:authError}=await auth.auth.getUser();
 if(authError||!user)return reply({error:"unauthorized"},401);
 const {data:profile,error:profileError}=await admin.from("monitor_profiles").select("is_admin,status").eq("id",user.id).maybeSingle();
 if(profileError||!profile||profile.is_admin!==true||profile.status!=="active")
   return reply({error:"admin_only"},403);
 let request:any;
 try{request=await req.json()}catch{return reply({error:"invalid_json"},400)}
 const action=String(request?.action||"");
 const noteId=String(request?.note_id||"");
 async function findNote(){
   if(!uuid.test(noteId))return null;
   const {data,error}=await admin.from("monitor_admin_notes").select("*").eq("id",noteId).maybeSingle();
   if(error)throw Error("note_read_failed");
   return data?cleanNote(data):null;
 }
 try{
   if(action==="list"){
     const {data,error}=await admin.from("monitor_admin_notes").select("*").order("updated_at",{ascending:false}).limit(40);
     if(error)throw Error("list_failed");
     return reply({notes:(data||[]).map(cleanNote)});
   }
   if(action==="create"){
     const {count,error:countError}=await admin.from("monitor_admin_notes").select("id",{count:"exact",head:true});
     if(countError)throw Error("count_failed");
     if((count||0)>=30)return reply({error:"max_notes",limit:30},400);
     const {data,error}=await admin.from("monitor_admin_notes").insert({title:"Новая памятка",body:"",created_by:user.id,updated_by:user.id}).select("*").single();
     if(error)throw Error("create_failed");
     return reply({note:cleanNote(data)});
   }
   if(action==="save"){
     if(!uuid.test(noteId))return reply({error:"invalid_note_id"},400);
     const title=String(request?.title||"").trim();
     const body=String(request?.body||"");
     if(!title||title.length>120||body.length>12000)return reply({error:"invalid_note_fields",max_title:120,max_body:12000},400);
     const {data,error}=await admin.from("monitor_admin_notes")
       .update({title,body,updated_by:user.id,updated_at:new Date().toISOString()}).eq("id",noteId).select("*").maybeSingle();
     if(error)throw Error("save_failed");
     if(!data)return reply({error:"note_not_found"},404);
     return reply({note:cleanNote(data)});
   }
   if(action==="delete"){
     const note=await findNote();
     if(!note)return reply({error:"note_not_found"},404);
     if(note.image_paths.length){
       const {error}=await admin.storage.from(bucket).remove(note.image_paths);
       if(error)throw Error("images_delete_failed");
     }
     const {error}=await admin.from("monitor_admin_notes").delete().eq("id",note.id);
     if(error)throw Error("delete_failed");
     return reply({deleted:true});
   }
   if(action==="upload"){
     const note=await findNote();
     if(!note)return reply({error:"note_not_found"},404);
     if(note.image_paths.length>=maxImages)return reply({error:"max_images",limit:maxImages},400);
     const mime=String(request?.mime||"");
     if(!["image/png","image/jpeg","image/webp"].includes(mime))return reply({error:"invalid_image_type"},400);
     const raw=String(request?.base64||"");
     if(!raw||raw.length>4100000||!/^[a-zA-Z0-9+/]*={0,2}$/.test(raw))
       return reply({error:"invalid_image_data"},400);
     let bytes:Uint8Array;
     try{
       const decoded=atob(raw);
       if(!decoded.length||decoded.length>3000000)return reply({error:"image_too_large",max_bytes:3000000},400);
       bytes=Uint8Array.from(decoded,ch=>ch.charCodeAt(0));
     }catch{return reply({error:"invalid_image_base64"},400)}
     const ext=mime==="image/png"?"png":mime==="image/jpeg"?"jpg":"webp";
     const path=note.id+"/"+crypto.randomUUID()+"."+ext;
     const {error:uploadError}=await admin.storage.from(bucket).upload(path,bytes,{contentType:mime,upsert:false});
     if(uploadError)throw Error("image_upload_failed");
     const {data,error}=await admin.from("monitor_admin_notes")
       .update({image_paths:[...note.image_paths,path],updated_by:user.id,updated_at:new Date().toISOString()})
       .eq("id",note.id).select("*").single();
     if(error){
       await admin.storage.from(bucket).remove([path]);
       throw Error("image_metadata_failed");
     }
     const {data:signed,error:signedError}=await admin.storage.from(bucket).createSignedUrl(path,900);
     if(signedError)throw Error("image_url_failed");
     return reply({note:cleanNote(data),path,signed_url:signed.signedUrl});
   }
   if(action==="remove_image"){
     const note=await findNote();
     if(!note)return reply({error:"note_not_found"},404);
     const path=String(request?.path||"");
     if(!note.image_paths.includes(path))return reply({error:"image_not_found"},404);
     const {error}=await admin.from("monitor_admin_notes")
       .update({image_paths:note.image_paths.filter(p=>p!==path),updated_by:user.id,updated_at:new Date().toISOString()}).eq("id",note.id);
     if(error)throw Error("image_remove_failed");
     const {error:storageError}=await admin.storage.from(bucket).remove([path]);
     if(storageError)console.warn("admin_notebook_orphaned_image",{path_count:1});
     return reply({removed:true});
   }
   if(action==="image_urls"){
     const note=await findNote();
     if(!note)return reply({error:"note_not_found"},404);
     const results=await Promise.all(note.image_paths.map(async path=>{
       const {data,error}=await admin.storage.from(bucket).createSignedUrl(path,900);
       return {path,url:error?"":String(data?.signedUrl||"")};
     }));
     return reply({images:results});
   }
   return reply({error:"unknown_action"},400);
 }catch(error){
   console.error("admin_notebook_failed",String(error).slice(0,90));
   return reply({error:"admin_notebook_failed"},503);
 }
});