import {warningRu} from './warnings.ts';
Deno.test('UI warnings are readable Russian and hide raw constraint details',()=>{
 const samples=[
  'duplicate key value violates unique constraint "l_news_observations_run_id_provider_provider_id_key"',
  'relevance_review_unavailable',
  'translation_unavailable',
  'GitHub-индекс: dashboard-bundle (TypeError: error sending request from Supabase)',
  'Достигнут лимит запросов: newscatcher',
  'newscatcher_search_429',
 ];
 for(const sample of samples){
  const translated=warningRu(sample);
  if(!/[А-Яа-яЁё]/.test(translated))throw new Error('Non-Russian warning: '+sample);
  if(/violates unique|relevance_review_unavailable|error sending request/i.test(translated))throw new Error('Technical raw error exposed: '+sample);
 }
});
Deno.test('A Russian warning remains understandable',()=>{
 const text='Достигнут разовый лимит запросов Perigon.';
 if(warningRu(text)!==text)throw new Error('Existing localized warning changed');
});
