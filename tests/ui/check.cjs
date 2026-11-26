const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || chromium.executablePath(),args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1676,height:1050}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message)});const calls=[];
 const settings={enabled:true,lookback_hours:26,local_time:'03:07',countries:['DE','IT','PL','UA','RU','FR','US'],newscatcher_enabled:true,newscatcher_per_run:32,newscatcher_daily_credits:200,newscatcher_monthly_credits:3500,newscatcher_reserve:500,cloro_enabled:true,cloro_per_run:4,cloro_daily_credits:12,cloro_monthly_credits:360,cloro_reserve:20,cloro_countries:['DE','IT','PL','UA','RU','FR','US'],currents_enabled:true,currents_languages:['de'],currents_per_run:4,currents_daily_requests:20,currents_monthly_requests:600,currents_reserve:10,candidate_limit:1200,paid_extractions_per_run:4,updated_at:'2026-11-26T05:20:00Z'};
 await page.route('https://qa.monitor.test/**',async route=>{
  const request=route.request();if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'authorization,apikey,content-type','access-control-allow-methods':'POST'}});
  const body=request.postDataJSON();calls.push(body);const id=body.assistant_id;
  if(body.action==='settings')Object.assign(settings,body,{updated_at:new Date().toISOString()});
  const runs=Array.from({length:8},(_,i)=>({id:`${id}-${10-i}`,number:30-i,assistant_number:10-i,status:i===0?'processing':'completed',to_at:'2026-11-26T05:00:00Z',counters:{ready:3,full_texts:2,already_known:23,newscatcher_credits:5,cloro_credits:6,currents_requests:1,perigon_requests:2,jobs_pending:3},warnings:[]}));
  const data={settings:id===2?settings:{...settings,local_time:'15:07',perigon_per_run:8},runs,terminal_run_id:body.terminal_run_id??runs[0].id,terminal:[{id:1,label:'Подготовка источников',state:'done',at:'2026-11-26T05:00:00Z'},{id:2,label:id===2?'Cloro: получение результатов':'Perigon',state:'done',at:'2026-11-26T05:00:04Z',returned:21,kept:3},{id:3,label:'Проверка, текст и перевод',state:'leased',at:'2026-11-26T05:00:08Z'}],providers:[{provider:'newscatcher',info:{subscription:{credits_balance:9395}},updated_at:'2026-11-26T05:00:00Z'},{provider:'cloro',info:{balance:{remaining:451}},updated_at:'2026-11-26T05:00:00Z'},{provider:'currents',info:{limits:{remaining:248,limit:250}},updated_at:'2026-11-26T05:00:00Z'}],sources:settings.countries.map(country=>({country,baseline:true,coverage:{}})),country_names:{DE:'Германия',IT:'Италия',PL:'Польша',UA:'Украина',RU:'Россия',FR:'Франция',US:'США'},usage_limits:{newscatcher:{today_units:5,period_units:5},cloro:{today_units:6,period_units:6},currents:{today_units:1,period_units:1}}};
  await route.fulfill({json:body.action==='status'?data:{ok:true},headers:{'access-control-allow-origin':'*'}});
 });
 for(let attempt=0;attempt<40;attempt++){try{await fetch('http://127.0.0.1:1421/tests/ui/');break;}catch{if(attempt===39)throw new Error('Preview server did not start');await new Promise(resolve=>setTimeout(resolve,250));}}
 await page.goto('http://127.0.0.1:1421/tests/ui/');await page.getByRole('heading',{name:'Помощник 1 · L-Monitor'}).waitFor();
 await page.locator('tbody tr').first().waitFor();assert.equal(await page.locator('tbody tr').count(),5);
 await page.getByRole('tab',{name:'Помощник 2'}).click();await page.getByRole('heading',{name:'Помощник 2 · L-Monitor'}).waitFor();await page.getByText('Cloro: остаток кредитов',{exact:true}).waitFor();
 assert.equal(await page.locator('tbody tr').count(),5);await page.screenshot({path:'tests/ui/assistant2-panel.png',fullPage:true});
 await page.getByText('Настройки поиска и расходов помощника 2',{exact:true}).click();
 const budget=page.locator('fieldset').filter({has:page.locator('legend', {hasText:'Cloro'})});
 await budget.getByLabel('Запросов на сбор',{exact:true}).fill('3');
 await page.getByRole('button',{name:'Сохранить настройки помощника 2'}).click();await page.getByText('Настройки сохранены.',{exact:true}).waitFor();
 const saved=calls.find(c=>c.action==='settings');assert.equal(saved.assistant_id,2);assert.equal(saved.cloro_per_run,3);assert.deepEqual(saved.currents_languages,['de']);
 await page.getByText('Настройки поиска и расходов помощника 2',{exact:true}).click();
 await page.screenshot({path:'tests/ui/assistant2-settings.png',fullPage:true});
 await page.getByRole('tab',{name:'Помощник 1'}).click();await page.getByRole('heading',{name:'Помощник 1 · L-Monitor'}).waitFor();assert.equal(await page.locator('fieldset').count(),0);
 assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth>window.innerWidth),false);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,rowsPerAssistant:5,settingsIsolated:true,terminal:true,consoleErrors:errors}));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
