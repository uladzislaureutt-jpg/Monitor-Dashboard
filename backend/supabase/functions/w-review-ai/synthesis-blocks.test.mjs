import test from 'node:test';
import assert from 'node:assert/strict';
import {readSynthesisBlocks,synthesisResponseSchema} from './synthesis-blocks.ts';
import {makeSynthesisDossier} from './editorial-dossier.ts';
const plan=[{id:'opening',title:'Зачин',targetChars:100,paragraphs:1},{id:'line_1',title:'Риски',targetChars:800,paragraphs:2},{id:'ending',title:'Финал',targetChars:100,paragraphs:1}];
test('short transitions accepted; only underfilled block warned',()=>{
 const r=readSynthesisBlocks({blocks:plan.map(b=>({block_id:b.id,paragraphs:['я'.repeat(b.id==='line_1'?300:100)]}))},plan);
 assert.equal(r.paragraphs.length,3);assert.equal(r.warnings.length,1);assert.match(r.warnings[0],/Риски.*300.*800/);
 assert.equal(r.metrics[1].actual_chars,300);
});
test('missing, duplicate, unknown blocks preserve prose and warn',()=>{
 const r=readSynthesisBlocks({blocks:[{block_id:'line_1',paragraphs:['А']},{block_id:'line_1',paragraphs:['Б']},{block_id:'other',paragraphs:['В']}]},plan);
 assert.deepEqual(r.paragraphs,['А','Б','В']);
 for(const text of ['отсутствует','повторила','неизвестным','Порядок'])assert.ok(r.warnings.some(w=>w.includes(text)));
});
test('legacy response preserved but never misreported as measured blocks',()=>{
 const r=readSynthesisBlocks({paragraphs:['Один','Два']},plan);
 assert.deepEqual(r.paragraphs,['Один','Два']);assert.equal(r.metrics.length,0);assert.equal(r.warnings.length,1);
});
test('schema permits natural short paragraphs and restricts IDs to selected blocks',()=>{
 const s=synthesisResponseSchema(plan);
 assert.deepEqual(s.properties.blocks.items.properties.block_id.enum,plan.map(b=>b.id));
 assert.equal(s.properties.blocks.items.properties.paragraphs.items.minLength,undefined);
});
const card='ИСТОЧНИК: «Reuters»\nE01 [fact/P001] Прогноз снизился на 2%. | SOURCE: «Прогноз снизился на 2%.»';
const branch={id:'B1',title:'Риск',claim:'Прогноз',mechanism:'',counterpoint:'',limitation:'',significance:'Риски',priority:'high',required:true,evidence_ids:['P01:E01'],contrary_evidence_ids:[]};
const dossier={version:3,trends:[{id:'T1',title:'Прогноз',thesis:'Снижение',sources:['Reuters'],branches:[branch]}],coverage:[]};
test('unified budgets conserve all target sizes and expose factual content near branch',()=>{
 for(const chars of [1000,3000,8000])for(const median of [0,100,600,1200]){
  const p=makeSynthesisDossier(dossier,['T1'],chars,[card],median);
  assert.equal(p.blocks.reduce((n,b)=>n+b.targetChars,0),chars);
  assert.equal(p.blocks.reduce((n,b)=>n+b.paragraphs,0),p.paragraphTarget);
  assert.match(p.text,/Прогноз снизился на 2%/);assert.doesNotMatch(p.text,/SOURCE:/);
  assert.deepEqual(p.blocks.map(b=>b.id),['opening','line_1','ending']);
 }
});
test('unselected trend never receives a block',()=>{
 const d={...dossier,trends:[...dossier.trends,{...dossier.trends[0],id:'T2',title:'Не выбрано'}]};
 const p=makeSynthesisDossier(d,['T1'],8000,[card]);
 assert.equal(p.blocks.length,3);assert.doesNotMatch(p.text,/Не выбрано/);
});
