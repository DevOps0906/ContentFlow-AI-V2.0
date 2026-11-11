/**
 * 템플릿 예시 이미지 생성. 사용:
 *   npx tsx --env-file=../../.env.local scripts/gen-template-images.ts
 * GEMINI_API_KEY는 환경 변수로만 받고 출력하지 않는다. 이미 있는 파일은 건너뛴다.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exampleImages, templateExamples } from "../src/lib/template-examples";

const MODEL = "gemini-3.1-flash-image";
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const OUT = path.join(__dirname, "..", "public", "template-examples");
const MAX_WIDTH = 1280;

async function resize(buf: Buffer, ext: string): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buf)
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch {
    console.warn(`sharp 없음 또는 변환 실패: 원본 유지(${ext})`);
    return buf;
  }
}

async function generate(prompt: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 환경 변수가 없습니다.");
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (res.status === 429)
    throw new Error("API 429: 쿼터 초과(결제·요금제 확인 필요)");
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = (await res.json()) as {
    candidates?: {
      content?: { parts?: { inlineData?: { data?: string } }[] };
    }[];
  };
  const data = json.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.data,
  )?.inlineData?.data;
  if (!data) throw new Error("응답에 이미지가 없습니다.");
  return Buffer.from(data, "base64");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const images = templateExamples.flatMap(exampleImages);
  let made = 0;
  let total = 0;
  const ready: string[] = [];
  for (const img of images) {
    const file = path.join(OUT, img.file);
    if (existsSync(file)) {
      total += statSync(file).size;
      ready.push(img.file);
      console.log(`건너뜀 ${img.file}`);
      continue;
    }
    try {
      const raw = await generate(img.prompt);
      const out = await resize(raw, path.extname(img.file));
      writeFileSync(file, out);
      made += 1;
      ready.push(img.file);
      total += out.length;
      console.log(`생성 ${img.file} ${Math.round(out.length / 1024)}KB`);
    } catch (e) {
      console.error(`실패 ${img.file}: ${(e as Error).message}`);
    }
  }
  writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(ready.sort(), null, 2) + "
",
  );
  console.log(
    `완료: 신규 ${made}장, 전체 ${images.length}장, 총 ${Math.round(total / 1024)}KB`,
  );
}
main();
