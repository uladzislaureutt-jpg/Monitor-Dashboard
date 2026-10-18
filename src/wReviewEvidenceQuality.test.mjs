import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceRegression} from './wReviewEvidenceQuality.ts';
const data=(n,c,hash='same')=>({version:2,source_sha256:hash,records:Array(n).fill({}),validation:{covered_passages:c}});
test('significant regression on unchanged original keeps previous extraction',()=>{
  assert.equal(evidenceRegression(data(20,15),data(10,8)),true);
  assert.equal(evidenceRegression(data(20,15),data(18,14)),false);
  assert.equal(evidenceRegression(data(20,15),data(23,7)),true);
});
test('changed original and old unaddressed cards never block fresh extraction',()=>{
  assert.equal(evidenceRegression(data(20,15),data(5,3,'changed')),false);
  assert.equal(evidenceRegression(data(20,15,''),data(5,3,'')),false);
  assert.equal(evidenceRegression(undefined,data(5,3)),false);
});
