"""근거 검사 이식 테스트. 확장 tests/unit/grounding.test.mjs와 같은 입력 → 같은 결과."""
import json
from pathlib import Path

import pytest

from app.grounding import (
    GROUNDING_REJECTED_TEXT,
    char_jaccard,
    check_grounding,
    normalize_text,
    numbers_in,
)

# 공통 그래프(maplestory.json)의 실제 facts
WEEKLY_BOSS = [
    "강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있다.",
    "보스를 잡으면 나오는 결정석(강렬한 힘의 결정)을 상점에 팔아 메소를 번다.",
    "한 주에 팔 수 있는 결정석 개수에는 상한이 있다.",
]
STARFORCE = [
    "메소를 내고 장비에 별(스타)을 붙여 능력치를 올리는 강화 시스템이다.",
    "별이 높아질수록 성공 확률은 낮아지고 한 번 시도하는 메소 비용은 커진다.",
    "높은 단계에서는 실패하면 장비가 파괴될 수 있고, 남은 흔적을 메소와 같은 장비로 복구해야 한다.",
]
BOSS_ENTRY = [
    "보스마다 입장할 수 있는 최소 레벨이 정해져 있다.",
    "같은 보스라도 난이도에 따라 필요한 스펙과 받는 보상이 다르다.",
]
SENTENCE = "이 적금은 한 달에 한 번만 납입할 수 있어요."
ANALOGY = "주간 보스처럼 정해진 주기마다 한 번만 보상을 받는 것과 같아요."

OK = (True, None)
FACT = (False, "fact-mismatch")
NUM = (False, "number-outside")


def check(**over):
    args = dict(analogy=ANALOGY, used_fact=WEEKLY_BOSS[0], facts=WEEKLY_BOSS, sentence=SENTENCE, context="")
    args.update(over)
    return check_grounding(**args)


def test_rejected_text_matches_extension():
    assert GROUNDING_REJECTED_TEXT == "근거에 없는 내용이 섞여 있어서 비유를 숨겼어요."


# 확장 사례 표(task-1-report.md)와 같은 순서
@pytest.mark.parametrize("over, expected", [
    ({}, OK),                                                                     # 1 글자 그대로
    ({"used_fact": "일주일에 한 번만 보상을 받을 수 있다"}, OK),                       # 2 부분
    ({"used_fact": "강한 보스 중  상당수는, 일주일에 한 번만 보상을 받을 수 있다!"}, OK),  # 3 공백·부호
    ({"used_fact": '"보스를 잡으면 나오는 결정석 강렬한 힘의 결정을 상점에 팔아 메소를 번다"'}, OK),  # 4
    ({"used_fact": "강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있어요."}, OK),     # 5 자카드
    ({"used_fact": STARFORCE[1]}, FACT),                                          # 6 다른 노드
    ({"used_fact": BOSS_ENTRY[0]}, FACT),                                         # 7 다른 노드
    ({"used_fact": "보스는 매주 한 번 보상을 준다"}, FACT),                           # 8 지어냄
    ({"facts": []}, FACT),                                                        # 9 facts 없음
    ({"facts": None}, FACT),
    ({"used_fact": None}, OK),                                                    # 10 usedFact 없음
    ({"used_fact": ""}, OK),
    ({"used_fact": "   "}, OK),
    ({"analogy": "일주일에 7번만 입장할 수 있는 것과 같아요."}, NUM),                  # 11 밖 숫자
    ({"analogy": "일주일에 7번만 입장할 수 있는 것과 같아요.", "used_fact": ""}, NUM),
    ({"analogy": "7번만 받는 것과 같아요.", "sentence": "17일에 한 번 납입해요."}, NUM),  # 12 토큰 단위
    ({"analogy": "주간 보스를 1년에 12번 도는 것처럼 한 번씩만 받는 것과 같아요.",
      "sentence": "1년에 12번 이자를 받아요."}, OK),                                # 13 원문 숫자
    ({"analogy": "주간 보스를 1년에 12번 도는 것처럼 한 번씩만 받는 것과 같아요.",
      "sentence": "이자를 받아요.", "context": "1년에 12번 나눠서 줘요."}, OK),       # 14 앞 문장 숫자
    ({"analogy": "주간 보스를 일주일에 3번 잡는 것과 같아요."}, NUM),                  # 16
    ({"analogy": "7번 같아요.", "used_fact": STARFORCE[0]}, FACT),                  # 17 fact가 먼저
    ({"analogy": "", "used_fact": STARFORCE[0]}, OK),                             # 18 비유 없음
    ({"analogy": None, "used_fact": "지어낸 말"}, OK),
    ({"analogy": "   "}, OK),
])
def test_case_table(over, expected):
    assert check(**over) == expected


def test_fact_number_passes():  # 15
    facts = ["길드 스킬은 레벨 10부터 배울 수 있다."]
    assert check_grounding("레벨 10이 돼야 배우는 것과 같아요.", facts[0], facts, "자격을 갖춰야 해요.", "") == OK


def test_short_used_fact_substring_passes():
    # 명세대로 최소 길이가 없다(확장과 같음)
    assert check(used_fact="메소") == OK


def test_fullwidth_numbers_nfkc():
    assert numbers_in("확률 １０%") == ["10"]
    assert numbers_in("１，０００ 메소") == ["1000"]
    assert check(analogy="１０번 시도하는 것과 같아요.", used_fact="", sentence="10번까지 할 수 있어요.")[0] is True


def test_non_ascii_digits_are_not_numbers():
    # JS \d는 ASCII만 본다. 아라비아-인도 숫자 ٣는 NFKC 뒤에도 숫자로 보지 않는다
    assert numbers_in("٣번") == []


SOL_ERDA = [
    "HEXA 매트릭스의 스킬을 강화하려면 솔 에르다와 솔 에르다 조각이 필요하다.",
    "솔 에르다는 어센틱 지역 사냥이나 특정 보스로 '솔 에르다의 기운' 게이지를 채워 얻고, 보유할 수 있는 양에 상한이 있다.",
]


def sol_check(**over):
    args = dict(analogy="6차 전직 뒤 HEXA 매트릭스를 키우는 솔 에르다와 같아요.", used_fact=SOL_ERDA[0],
                facts=SOL_ERDA, sentence=SENTENCE, context="")
    args.update(over)
    return check_grounding(**args)


def test_neighbor_label_numbers_pass():
    assert sol_check(labels=["솔 에르다", "6차 전직과 HEXA 매트릭스"]) == OK
    assert sol_check() == NUM  # labels 없으면 기존대로


def test_node_label_numbers_pass():
    assert check_grounding("6차 전직을 해야 새 성장 시스템이 열리는 것과 같아요.", "",
                           ["전직하면 새 스킬 성장 시스템이 열린다."], SENTENCE, None,
                           labels=["6차 전직과 HEXA 매트릭스"]) == OK


def test_labels_do_not_count_for_used_fact():
    labels = ["솔 에르다", "6차 전직과 HEXA 매트릭스"]
    assert sol_check(used_fact="6차 전직과 HEXA 매트릭스", labels=labels) == FACT


def test_helpers():
    assert normalize_text(" 결정석(강렬한 힘의 결정)을, 판다! ") == "결정석강렬한힘의결정을판다"
    assert normalize_text(None) == ""
    assert numbers_in("7번, 12일, 1,000메소") == ["7", "12", "1000"]
    assert numbers_in("숫자 없음") == []
    assert numbers_in(None) == []
    assert char_jaccard("같은 문장이에요", "같은 문장이에요") == 1
    assert char_jaccard("가나다라", "마바사아") == 0
    assert char_jaccard("", "") == 0
    assert char_jaccard("강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있어요.", WEEKLY_BOSS[0]) >= 0.6
    assert char_jaccard("보스는 매주 한 번 보상을 준다", WEEKLY_BOSS[0]) < 0.6


# T-143: 한글 수사·만/천 단위 수. 확장 tests/unit/grounding.test.mjs와 같은 공유 사례를 읽는다
SHARED = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/grounding-numbers.json").read_text("utf-8"))


@pytest.mark.parametrize("case", SHARED["numbers"], ids=lambda c: c["text"])
def test_shared_numbers(case):
    assert numbers_in(case["text"]) == case["numbers"]


@pytest.mark.parametrize("case", SHARED["checks"], ids=lambda c: c["note"])
def test_shared_checks(case):
    i = case["input"]
    got = check_grounding(i.get("analogy"), i.get("usedFact"), i.get("facts"), i.get("sentence"),
                          i.get("context"), labels=i.get("labels"))
    assert got == (case["ok"], case["reason"])
