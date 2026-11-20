import {createClient} from 'npm:@supabase/supabase-js@2.98.0';
import type {Runtime} from './providers.ts';
import {createCollectorHandler} from './handler.ts';

const environment=Deno.env.toObject();
function secret(...names:string[]):string {for(const name of names){const key=Object.keys(environment).find(k=>k.toLowerCase()===name.toLowerCase());if(key&&environment[key])return environment[key];}return '';}
const db=createClient(secret('SUPABASE_URL'),secret('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const rt:Runtime={db,secret,perigonKey:secret('PERIGON_API_KEY','PERIGON_KEY','PERIGON_API_TOKEN'),newscatcherKey:secret('NEWSCATCHER_API_KEY','NEWSCATCHER_KEY','NEWSCATCHER_API_TOKEN','NEWS_CATCHER_API_KEY')};

Deno.serve(createCollectorHandler(rt));
