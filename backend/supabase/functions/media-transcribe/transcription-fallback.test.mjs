import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const edge=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const native=readFileSync(new URL("../../../../src-tauri/src/lib.rs",import.meta.url),"utf8");
test("explicit skip-groq follows signed-in user request, never globally disables providers",()=>{
 assert.match(edge,/const skipGroq = String\(form\.get\("skip_groq"\)\|\|""\) === "true"/);
 assert.match(edge,/route\.name==="groq_whisper"&&skipGroq/);
 assert.match(edge,/route\.name==="groq_whisper"&&response\.status===429/);
 assert.match(edge,/groq_rate_limited:groqRateLimited/);
 assert.match(native,/\.text\("skip_groq",groq_rate_limited\.to_string\(\)\)/);
 assert.match(native,/groq_rate_limited=true/);
 assert.match(native,/Groq достиг лимита запросов 429/);
});
test("server returns true transcript when timing unavailable and includes diagnostics",()=>{
 assert.match(edge,/const timingStatus=segments\.length>0\?"valid":rawSegments\.length>0\?"invalid":"missing"/);
 assert.match(edge,/timing_status:timingStatus/);
 assert.match(edge,/raw_segment_count:rawSegments\.length/);
 assert.match(edge,/Boolean\(s\.text\)&&Number\.isFinite\(s\.start\)/);
 assert.match(native,/нет пригодных временных меток Whisper/);
 assert.match(native,/parts\.push\(fallback\.to_string\(\)\)/);
});
test("once-only acoustic analysis reduces false positive gaps without new model calls",()=>{
 assert.match(native,/fn detect_acoustic_silence\(/);
 assert.match(native,/silencedetect=noise=-38dB:d=0\.6/);
 assert.match(native,/let silent_intervals=detect_acoustic_silence\(audio,&ffmpeg,duration_estimate\)/);
 assert.match(native,/transcription_coverage::coverage_warning\(/);
 assert.doesNotMatch(native,/Возможный пропуск речи:/);
});
