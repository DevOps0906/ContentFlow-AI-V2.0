import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { templates } from "../src/lib/templates";
import {
  exampleImages,
  findTemplateExample,
  hasExampleImage,
  templateExamples,
} from "../src/lib/template-examples";

const IMG_DIR = path.join(__dirname, "..", "public", "template-examples");

test("10종 템플릿 모두 예시가 있고 블록 순서가 정의와 같다", () => {
  assert.equal(templateExamples.length, templates.length);
  for (const t of templates) {
    const ex = findTemplateExample(t.id);
    assert.ok(ex, `${t.id} 예시 없음`);
    assert.deepEqual(
      ex.sections.map((s) => s.block),
      t.blocks,
      `${t.id} 블록 순서`,
    );
    assert.ok(ex.title.trim());
    assert.ok(exampleImages(ex).length >= 1, `${t.id} 이미지 슬롯 없음`);
  }
});

test("이미지 슬롯은 총 15장 이하이고 파일명이 겹치지 않는다", () => {
  const all = templateExamples.flatMap(exampleImages);
  assert.ok(all.length <= 15);
  assert.equal(new Set(all.map((i) => i.file)).size, all.length);
  for (const i of all) assert.ok(i.alt && i.caption && i.prompt);
});

// manifest에 기록된 파일만 존재해야 한다(비어 있으면 자리표시자로 표시).
test("manifest의 이미지 파일이 모두 존재하고 슬롯에 속한다", () => {
  const slots = new Set(templateExamples.flatMap(exampleImages).map((i) => i.file));
  const listed = JSON.parse(
    readFileSync(path.join(IMG_DIR, "manifest.json"), "utf8"),
  ) as string[];
  for (const f of listed) {
    assert.ok(slots.has(f), `${f} 슬롯 아님`);
    assert.ok(existsSync(path.join(IMG_DIR, f)), `${f} 없음`);
    assert.equal(hasExampleImage(f), true);
  }
});
