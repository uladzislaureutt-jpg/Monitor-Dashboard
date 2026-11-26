// Client-facing warnings are always Russian. Keep machine-readable job.error
// unchanged in the database for retries and operational diagnostics.
export function warningRu(value:unknown):string{
 const raw=String(value||'').trim();
 const t=raw.toLowerCase();
 if(!raw)return 'Неизвестное предупреждение сборщика.';
 if(/duplicate key value violates unique constraint/.test(t))
  return 'Повторная находка уже присутствует в журнале. Сборщик не смог завершить обработку одного поискового задания; повторная запись будет пропущена.';
 if(t.includes('relevance_review_unavailable'))
  return 'Семантическая проверка не завершена: модели ИИ не предоставили пригодный ответ.';
 if(t.includes('translation_unavailable'))
  return 'Не удалось перевести материал: модели перевода не предоставили пригодный ответ.';
 if(t.includes('github-индекс')&&(/typeerror|error sending request|timeout|transport|connect|failed|supabase|network/i.test(t)))
  return 'GitHub-индекс: не удалось загрузить или записать часть архива из-за временной сетевой ошибки.';
 if(t.includes('github-индекс'))return 'GitHub-индекс: не удалось обработать один из архивов. Подробности сохранены в техническом журнале.';
 if(t.includes('достигнут лимит запросов: newscatcher'))return 'Достигнут разовый лимит запросов Newscatcher.';
 if(t.includes('достигнут лимит запросов: perigon'))return 'Достигнут разовый лимит запросов Perigon.';
 if(t.includes('достигнут лимит запросов: gdelt'))return 'Достигнут разовый лимит запросов GDELT.';
 if(/(?:newscatcher|perigon|gdelt)_(?:search|subscription)_(?:429|503|502|504|500)/.test(t)){
  const provider=t.includes('newscatcher')?'Newscatcher':t.includes('perigon')?'Perigon':'GDELT';
  if(t.includes('_429'))return provider+': сервис ограничил частоту запросов (HTTP 429).';
  return provider+': временная ошибка сервиса (HTTP 5xx).';
 }
 if(/(?:transport|timeout|connection|network|fetch failed|error sending request)/.test(t))
  return 'Сетевая ошибка или превышено время ожидания ответа источника.';
 if(t.includes('rate limit')||t.includes('quota'))return 'Достигнут лимит внешнего сервиса.';
 if(t.includes('invalid_response'))return 'Провайдер вернул ответ в неожиданном формате.';
 // A warning already written in Russian does not require rewriting.
 if(/[А-Яа-яЁё]{4,}/.test(raw)&&!/typeerror|error sending request|violates|constraint|status code/i.test(raw))return raw;
 return 'Ошибка обработки задания. Технические сведения сохранены в журнале диагностики.';
}
