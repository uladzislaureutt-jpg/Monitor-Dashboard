import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const pkg=JSON.parse(read("../package.json"));
const lock=JSON.parse(read("../package-lock.json"));
const cfg=JSON.parse(read("../src-tauri/tauri.conf.json"));
const cargo=read("../src-tauri/Cargo.toml");
test("Windows title, displayed version, installer and npm packages use same version",()=>{
  const match=cargo.match(/^version\s*=\s*"([^"]+)"/m);
  assert.ok(match,"missing Rust package version");
  assert.equal(pkg.version,lock.version);
  assert.equal(pkg.version,lock.packages[""].version);
  assert.equal(pkg.version,cfg.version);
  assert.equal(pkg.version,match[1]);
  assert.equal(cfg.app.windows[0].title,"Monitor "+cfg.version);
});
