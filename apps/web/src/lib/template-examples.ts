import manifest from "../../public/template-examples/manifest.json";

/**
 * 템플릿별 예시 글. 제품·기관·가격·수치는 모두 가상이다(실존 브랜드·인물 없음).
 * sections의 block 순서는 templates.ts의 blocks와 같아야 한다(테스트가 확인).
 */
export type ExampleImage = {
  file: string; // /template-examples/ 아래 파일명
  alt: string;
  caption: string;
  prompt: string; // 이미지 생성 프롬프트(글자 없는 이미지)
};
export type ExampleSection = {
  block: string;
  paragraphs: string[];
  items?: string[];
  image?: ExampleImage;
};
export type TemplateExample = {
  templateId: string;
  title: string;
  sections: ExampleSection[];
};

export const EXAMPLE_NOTICE = "예시 글 — 가상 정보";
export const IMAGE_NOTICE = "AI 생성 예시 이미지";
export const EXAMPLE_IMAGE_DIR = "/template-examples/";

const STYLE =
  " No text, no letters, no numbers, no logos, no watermarks, no real brands or people. Clean modern editorial photo style, soft natural light.";

export const templateExamples: TemplateExample[] = [
  {
    templateId: "T01",
    title: "재택근무 모니터 높이, 어느 정도가 적당할까",
    sections: [
      {
        block: "핵심 답변",
        paragraphs: [
          "모니터 상단이 눈높이와 같거나 약간 아래에 오고, 눈과 화면 거리가 팔 길이 정도(50~70cm)면 대부분 적당합니다.",
        ],
      },
      {
        block: "대상과 적용 조건",
        paragraphs: [
          "하루 4시간 이상 데스크에 앉아 일하는 성인에게 해당합니다. 노트북을 단독으로 쓰는 경우에는 외장 키보드와 거치대를 함께 써야 같은 기준을 맞출 수 있습니다.",
        ],
      },
      {
        block: "단계별 안내",
        paragraphs: ["아래 순서대로 조정해 보세요."],
        items: [
          "의자에 깊숙이 앉아 허리를 등받이에 붙입니다.",
          "팔을 앞으로 뻗어 손끝이 화면에 닿는 거리로 모니터를 놓습니다.",
          "화면 상단이 눈높이에 오도록 받침대나 모니터 암으로 높이를 맞춥니다.",
          "10분 일한 뒤 목과 어깨가 편한지 확인하고 미세 조정합니다.",
        ],
        image: {
          file: "t01-desk.webp",
          alt: "모니터 높이를 맞춘 정돈된 책상",
          caption: "눈높이에 맞춘 모니터와 바른 자세의 책상 배치",
          prompt:
            "A tidy home office desk with a monitor raised on a stand to eye level, keyboard, plant, bright room, seen from the side." +
            STYLE,
        },
      },
      {
        block: "주의 사항",
        paragraphs: [
          "통증이나 저림이 계속되면 자세 조정만으로 해결하려 하지 말고 전문가 상담을 받으세요. 이 글은 일반 정보이며 진단이 아닙니다.",
        ],
      },
      {
        block: "FAQ",
        paragraphs: [
          "Q. 모니터가 두 대면? 주로 보는 화면을 정면에 두고 보조 화면을 옆에 약간 안쪽으로 기울입니다.",
        ],
      },
      {
        block: "출처",
        paragraphs: [
          "가상 출처: 예시 인체공학 연구소 작업 환경 지침 (확인일 2026-01-15, 가상).",
        ],
      },
    ],
  },
  {
    templateId: "T02",
    title: "앱 실행 시 'Connection refused' 오류 해결하기",
    sections: [
      {
        block: "증상과 오류 메시지",
        paragraphs: [
          "개발 서버를 켰는데 브라우저에서 접속이 안 되고 터미널에 아래 메시지가 나타납니다.",
        ],
        items: ["Error: connect ECONNREFUSED 127.0.0.1:5000 (가상 예시)"],
      },
      {
        block: "사용 환경과 버전",
        paragraphs: [
          "예시 운영체제 12, 예시 런타임 v20.1, 예시 프레임워크 v4.2 (모두 가상 환경)에서 재현했습니다.",
        ],
      },
      {
        block: "원인과 우선 점검",
        paragraphs: [
          "대부분 서버가 아직 시작되지 않았거나, 다른 프로그램이 같은 포트를 쓰고 있어서 생깁니다.",
        ],
        items: [
          "서버 프로세스가 실제로 실행 중인지 확인",
          "포트 번호가 설정 파일과 같은지 확인",
          "방화벽이 로컬 연결을 막는지 확인",
        ],
      },
      {
        block: "단계별 해결",
        paragraphs: ["점검 결과 포트 충돌이라면 아래 순서로 해결합니다."],
        items: [
          "포트를 사용 중인 프로세스를 찾아 종료합니다.",
          "설정 파일의 포트를 5001로 바꿉니다.",
          "서버를 다시 시작합니다.",
        ],
        image: {
          file: "t02-terminal.webp",
          alt: "오류를 확인 중인 개발자 작업 화면",
          caption: "터미널로 서버 상태를 점검하는 작업 환경",
          prompt:
            "A developer workstation at night with a dark code editor and terminal panes on a monitor, abstract glowing lines instead of readable text, moody blue light." +
            STYLE,
        },
      },
      {
        block: "성공 확인",
        paragraphs: [
          "브라우저에서 http://localhost:5001 접속 시 첫 화면이 열리면 성공입니다. 여전히 실패하면 로그 전체를 저장해 두세요.",
        ],
      },
      {
        block: "출처",
        paragraphs: [
          "가상 출처: 예시 프레임워크 공식 문서 '네트워크 오류' 항목 (가상).",
        ],
      },
    ],
  },
  {
    templateId: "T03",
    title: "청년 월세 지원금, 누가 어떻게 신청하나 (가상 제도)",
    sections: [
      {
        block: "정보 기준일",
        paragraphs: [
          "2026-03-01 공고 기준(가상). 실제 신청 전 반드시 해당 기관의 최신 공고를 확인하세요.",
        ],
      },
      {
        block: "지원 대상",
        paragraphs: [
          "만 19~34세, 무주택, 월세 60만원 이하 임차인(가상 조건). 소득 기준은 공고문에서 확인합니다.",
        ],
      },
      {
        block: "기간과 조건",
        paragraphs: [
          "신청 기간은 2026-03-10부터 2026-04-10까지(가상)이며, 최대 12개월간 월 20만원 한도로 지급됩니다.",
        ],
      },
      {
        block: "공식 신청 절차",
        paragraphs: ["신청은 아래 순서로 진행됩니다."],
        items: [
          "예시 지원센터 누리집에서 본인 인증",
          "임대차 계약서와 소득 증빙 업로드",
          "심사 결과 문자 안내 확인",
        ],
        image: {
          file: "t03-apply.webp",
          alt: "서류를 확인하며 온라인으로 신청하는 모습",
          caption: "서류를 준비해 온라인으로 신청하는 장면",
          prompt:
            "A bright desk with a laptop, paperwork folders and a pen, prepared for an online application, friendly clean photo, no people." +
            STYLE,
        },
      },
      {
        block: "주의 사항",
        paragraphs: [
          "허위 서류는 환수 대상입니다. 사칭 문자나 대행 사이트에 개인정보를 입력하지 마세요.",
        ],
      },
      {
        block: "공식 출처",
        paragraphs: ["가상 출처: 예시 주거복지센터 2026년 제3호 공고 (가상)."],
      },
    ],
  },
  {
    templateId: "T04",
    title: "일정 관리 앱 A vs B, 1인 사업자에게 맞는 쪽은",
    sections: [
      {
        block: "비교 대상과 기준",
        paragraphs: [
          "가상의 일정 앱 '플랜노트'와 '데이캔버스'를 가격, 연동, 모바일 사용성 세 기준으로 비교합니다. 가격은 2026-02-01 확인(가상)입니다.",
        ],
      },
      {
        block: "가격과 기능 비교",
        paragraphs: ["두 서비스의 핵심 차이는 아래와 같습니다."],
        items: [
          "플랜노트: 월 4,900원, 캘린더 연동 3개, 팀 공유 없음",
          "데이캔버스: 월 7,900원, 캘린더 연동 무제한, 팀 공유 5명",
        ],
        image: {
          file: "t04-compare.webp",
          alt: "두 대의 기기에 열린 서로 다른 일정 화면",
          caption: "두 일정 앱을 나란히 비교하는 장면",
          prompt:
            "Two tablets side by side on a wooden table showing abstract colorful calendar layouts without any text, top view, minimal." +
            STYLE,
        },
      },
      {
        block: "장점과 단점",
        paragraphs: [
          "플랜노트는 가볍고 저렴하지만 연동이 제한됩니다. 데이캔버스는 기능이 많은 대신 처음 설정이 복잡합니다.",
        ],
      },
      {
        block: "대상별 선택 안내",
        paragraphs: [
          "혼자 일하며 단순한 관리가 필요하면 플랜노트, 외주 파트너와 일정을 공유한다면 데이캔버스를 권합니다.",
        ],
      },
      {
        block: "한계와 조건",
        paragraphs: ["가격은 변동될 수 있고, 평가는 2주 사용 경험에 근거합니다."],
        image: {
          file: "t04-choice.webp",
          alt: "책상 위 노트와 스마트폰 일정",
          caption: "상황에 맞는 도구를 고르는 모습",
          prompt:
            "A freelancer's desk with a notebook, coffee and a smartphone showing an abstract schedule, warm morning light, top-down." +
            STYLE,
        },
      },
      {
        block: "출처",
        paragraphs: [
          "가상 출처: 각 서비스 공식 요금 페이지 (2026-02-01 확인, 가상).",
        ],
      },
    ],
  },
  {
    templateId: "T05",
    title: "무선 이어폰 '에코버드 X' 2주 사용 후기 (가상 제품)",
    sections: [
      {
        block: "사용 환경과 증거",
        paragraphs: [
          "출퇴근 지하철과 사무실에서 2주간 하루 3시간 사용했습니다. 구매 영수증과 사용 사진을 증빙으로 첨부합니다(가상).",
        ],
        image: {
          file: "t05-earbuds.webp",
          alt: "책상 위에 놓인 무선 이어폰과 충전 케이스",
          caption: "실사용 환경에서 촬영한 이어폰과 케이스",
          prompt:
            "Generic white wireless earbuds with a small charging case on a desk next to a notebook, soft daylight, macro product photo, no brand marks." +
            STYLE,
        },
      },
      {
        block: "직접 사용한 과정",
        paragraphs: [
          "첫 주는 지하철에서, 둘째 주는 사무실 통화 위주로 사용하며 배터리 시간을 기록했습니다.",
        ],
      },
      {
        block: "좋았던 점",
        paragraphs: ["착용감이 가볍고, 통화 음질이 또렷했습니다."],
      },
      {
        block: "아쉬웠던 점",
        paragraphs: [
          "케이스가 두껍고 노이즈 캔슬링은 지하철 소음에서 한계가 있었습니다.",
        ],
      },
      {
        block: "사용 한계",
        paragraphs: ["운동 중 사용과 장거리 비행에서는 써 보지 않았습니다."],
      },
      {
        block: "증빙과 출처",
        paragraphs: ["구매 영수증, 배터리 기록 캡처(가상). 협찬 없음."],
        image: {
          file: "t05-case.webp",
          alt: "충전 케이스를 손에 든 모습",
          caption: "케이스 크기를 손과 비교한 모습",
          prompt:
            "A hand holding a small charging case for earbuds, shallow depth of field, neutral background, no brand marks." +
            STYLE,
        },
      },
    ],
  },
  {
    templateId: "T06",
    title: "작은 동네 서점이 다시 문을 연 날",
    sections: [
      {
        block: "이야기의 배경",
        paragraphs: [
          "골목 끝 작은 서점은 한동안 불이 꺼져 있었습니다. 이 글은 가상의 서점 '골목책방'의 이야기입니다.",
        ],
      },
      {
        block: "검증된 상황과 경험",
        paragraphs: [
          "주인은 직접 책장을 다시 짜고 동네 주민에게 헌책을 기부받았다고 합니다(가상 경험, 실제 글에서는 본인 경험으로 대체).",
        ],
        image: {
          file: "t06-bookshop.webp",
          alt: "따뜻한 조명의 작은 동네 서점 내부",
          caption: "다시 문을 연 서점의 오후",
          prompt:
            "Cozy small neighborhood bookshop interior with wooden shelves and warm lights in the afternoon, book spines without readable text, inviting atmosphere, no people." +
            STYLE,
        },
      },
      {
        block: "과정과 변화",
        paragraphs: [
          "첫 주에는 손님이 몇 명뿐이었지만, 한 달이 지나자 주민 독서 모임이 생겼습니다.",
        ],
      },
      {
        block: "독자에게 주는 의미",
        paragraphs: ["작은 공간이 사람을 이어 주는 방식을 생각해 보게 됩니다."],
      },
      {
        block: "사진과 증빙",
        paragraphs: [
          "사진은 본인이 촬영했거나 사용 허락을 받은 자료만 사용합니다.",
        ],
      },
    ],
  },
  {
    templateId: "T07",
    title: "자취생 전기포트 3종 비교 (제휴 링크 포함, 가상 제품)",
    sections: [
      {
        block: "경제적 관계 고지",
        paragraphs: [
          "이 글에는 제휴 링크가 포함되어 있으며, 구매 시 작성자가 일정 수수료를 받을 수 있습니다. 가격에는 영향이 없습니다.",
        ],
      },
      {
        block: "구매 기준",
        paragraphs: ["용량, 끓는 속도, 세척 편의성 세 가지를 기준으로 했습니다."],
      },
      {
        block: "제품 비교",
        paragraphs: ["가상의 세 제품을 같은 조건에서 비교했습니다."],
        items: [
          "A포트 1.0L: 29,000원, 끓는 시간 약 4분",
          "B포트 1.7L: 39,000원, 끓는 시간 약 5분",
          "C포트 0.8L: 24,000원, 끓는 시간 약 3분",
        ],
        image: {
          file: "t07-kettles.webp",
          alt: "주방 조리대 위에 놓인 세 개의 전기포트",
          caption: "비교한 세 가지 전기포트",
          prompt:
            "Three electric kettles in different sizes and colors lined up on a bright kitchen counter, no brand logos, product comparison photo." +
            STYLE,
        },
      },
      {
        block: "제한과 주의",
        paragraphs: ["가격은 2026-02-10 기준(가상)이며 변동될 수 있습니다."],
      },
      {
        block: "제휴 링크",
        paragraphs: [
          "제휴 링크 자리(예시). 실제 글에서는 링크 옆에 제휴 표시를 붙입니다.",
        ],
      },
      {
        block: "출처",
        paragraphs: ["제조사 공개 사양, 직접 측정 기록(가상)."],
      },
    ],
  },
  {
    templateId: "T08",
    title: "대중교통 요금 개편, 무엇이 달라졌나 (가상 시나리오)",
    sections: [
      {
        block: "사실 기준 시각",
        paragraphs: [
          "2026-05-02 09:00 발표 기준(가상). 이후 변경은 후속 확인 절을 참고하세요.",
        ],
      },
      {
        block: "무엇이 달라졌나",
        paragraphs: [
          "기본요금이 100원 오르고, 환승 할인 범위가 30분에서 60분으로 늘어납니다(가상).",
        ],
        image: {
          file: "t08-transit.webp",
          alt: "지하철 승강장을 지나는 사람들",
          caption: "출퇴근 시간 지하철 승강장",
          prompt:
            "A modern subway platform with an arriving train and blurred distant commuters, no signs with readable text." +
            STYLE,
        },
      },
      {
        block: "영향받는 대상",
        paragraphs: ["정기 이용자와 환승이 잦은 통근자에게 영향이 큽니다."],
      },
      {
        block: "확인된 사실",
        paragraphs: [
          "시행일은 2026-06-01이며 정기권은 별도 고지 예정입니다(가상).",
        ],
      },
      {
        block: "후속 확인",
        paragraphs: ["정기권 가격은 발표 전이므로 2026-05-15에 다시 확인합니다."],
      },
      {
        block: "공식 발표",
        paragraphs: ["가상 출처: 예시 교통공사 보도자료 (2026-05-02)."],
      },
    ],
  },
  {
    templateId: "T09",
    title: "처음 만드는 할 일 목록 웹앱 튜토리얼",
    sections: [
      {
        block: "환경과 버전",
        paragraphs: ["예시 런타임 v20, 예시 에디터, 인터넷 연결(가상 환경)."],
      },
      {
        block: "예상 결과",
        paragraphs: [
          "브라우저에서 할 일을 추가·완료·삭제할 수 있는 한 페이지 앱이 완성됩니다.",
        ],
        image: {
          file: "t09-app.webp",
          alt: "완성된 할 일 목록 앱 화면 개념도",
          caption: "완성된 앱의 모습(개념 이미지)",
          prompt:
            "A laptop on a desk showing an abstract minimal to-do list app with checkboxes and colored bars, no readable text, clean workspace." +
            STYLE,
        },
      },
      {
        block: "준비와 설치",
        paragraphs: ["프로젝트 폴더를 만들고 의존성을 설치합니다."],
        items: ["폴더 생성", "초기화 명령 실행", "개발 서버 실행 확인"],
      },
      {
        block: "실행 과정",
        paragraphs: ["입력창, 목록, 완료 토글 순서로 기능을 추가합니다."],
      },
      {
        block: "결과 검증",
        paragraphs: ["항목 3개를 추가하고 새로고침해도 유지되는지 확인합니다."],
      },
      {
        block: "FAQ와 출처",
        paragraphs: [
          "Q. 저장이 안 돼요. 브라우저 저장소 권한을 확인하세요. 가상 출처: 예시 프레임워크 공식 문서.",
        ],
      },
    ],
  },
  {
    templateId: "T10",
    title: "재택근무 빈도와 업무 만족도 조사 (가상 데이터)",
    sections: [
      {
        block: "핵심 결론",
        paragraphs: [
          "주 2~3일 재택 그룹의 만족도가 가장 높게 나타났습니다(가상 데이터).",
        ],
      },
      {
        block: "조사 방법",
        paragraphs: [
          "2026년 1월, 직장인 500명을 대상으로 한 가상의 온라인 설문입니다.",
        ],
      },
      {
        block: "원본 데이터",
        paragraphs: ["재택 빈도별 평균 만족도(5점 만점, 가상)."],
        items: [
          "전면 출근 3.4",
          "주 1일 재택 3.8",
          "주 2~3일 재택 4.3",
          "상시 재택 4.0",
        ],
        image: {
          file: "t10-chart.webp",
          alt: "막대그래프 형태의 추상 데이터 시각화",
          caption: "빈도별 만족도 개념 그래프(수치 없음)",
          prompt:
            "An abstract clean bar chart illustration in green and blue tones on a light background, bars of different heights, no axis labels." +
            STYLE,
        },
      },
      {
        block: "분석 결과",
        paragraphs: [
          "만족도는 재택 빈도와 선형이 아니라 중간 구간에서 가장 높았습니다.",
        ],
      },
      {
        block: "해석의 한계",
        paragraphs: ["표본이 작고 자기 보고 방식이어서 인과를 단정할 수 없습니다."],
      },
      {
        block: "출처와 확인일",
        paragraphs: ["가상 데이터셋, 사용권 자체 보유, 확인일 2026-02-01."],
      },
    ],
  },
];

export function findTemplateExample(templateId: string) {
  return templateExamples.find((e) => e.templateId === templateId);
}
export function exampleImages(example: TemplateExample): ExampleImage[] {
  return example.sections.flatMap((s) => (s.image ? [s.image] : []));
}

/** 생성 스크립트가 기록한 manifest에 있는 이미지만 실제 파일로 쓴다. */
export function hasExampleImage(file: string) {
  return (manifest as string[]).includes(file);
}
