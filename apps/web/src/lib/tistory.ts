// Tistory hand-off package (P0-08), built in the browser. Tistory has no API here, so an operator
// pastes the files by hand. Images are not included. Nothing in this file publishes anything.
import type { Article } from "./content";
import { assertDeliverable, type DeliveryCheck } from "./delivery";
import { toWpContent } from "./wordpress";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const UTF8_NAMES = 0x0800;
// 1980-01-01, the earliest ZIP date: the same article always produces the same bytes.
const DOS_DATE = 0x0021;

/** ZIP archive without compression (method 0, "store"). */
export function zipStore(files: { name: string; content: string }[]) {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const data = encoder.encode(f.content);
    return { name: encoder.encode(f.name), data, crc: crc32(data) };
  });
  const out = new Uint8Array(
    entries.reduce((n, e) => n + 30 + 46 + 2 * e.name.length + e.data.length, 22),
  );
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => {
    view.setUint16(at, v, true);
    at += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(at, v, true);
    at += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };
  // version needed … extra length: identical in the local and the central header.
  const shared = (e: (typeof entries)[number]) => {
    u16(20);
    u16(UTF8_NAMES);
    u16(0); // store
    u16(0); // time
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0);
  };

  const offsets = entries.map((e) => {
    const offset = at;
    u32(0x04034b50);
    shared(e);
    bytes(e.name);
    bytes(e.data);
    return offset;
  });
  const centralStart = at;
  entries.forEach((e, i) => {
    u32(0x02014b50);
    u16(20); // version made by
    shared(e);
    u16(0); // comment length
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    bytes(e.name);
  });
  const centralSize = at - centralStart;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralSize);
  u32(centralStart);
  u16(0);
  return out;
}

/** The article's keyword field is free text: commas or line breaks separate tags. */
export function tistoryTags(keyword: string): string[] {
  return [...new Set(keyword.split(/[,，\n]/).map((t) => t.trim()).filter(Boolean))];
}

const GUIDE = `ContentFlow AI 티스토리 게시 안내

이 패키지는 티스토리에 자동으로 게시되지 않습니다. 아래 순서로 직접 게시해주세요.

1. 티스토리 글쓰기 화면을 열고 편집 모드를 HTML로 바꿉니다.
2. article.html 내용을 붙여 넣습니다. 제목은 meta.json의 title을 사용합니다.
3. tags.txt의 태그를 태그 입력란에 넣습니다.
4. 이미지는 패키지에 포함되지 않습니다. 필요한 이미지는 권리를 확인한 뒤 직접 올려주세요.
5. 게시한 뒤 ContentFlow AI에서 공개된 글의 주소를 입력하고 '게시 완료 확인'을 눌러주세요.
`;

/** Refuses an article that may not be delivered, whichever screen asks for the package. */
export async function tistoryPackage(article: Article, check?: DeliveryCheck) {
  await assertDeliverable(article, check);
  const tags = tistoryTags(article.keyword);
  const meta = {
    title: article.title,
    tags,
    sourceUrl: article.sourceUrl,
    templateId: article.templateId,
    articleId: article.id,
    updatedAt: article.updatedAt,
  };
  return {
    name: `contentflow-${article.id}-tistory.zip`,
    data: zipStore([
      { name: "article.html", content: toWpContent(article) },
      { name: "tags.txt", content: tags.join(", ") },
      { name: "meta.json", content: JSON.stringify(meta, null, 2) },
      { name: "README.txt", content: GUIDE },
    ]),
  };
}
