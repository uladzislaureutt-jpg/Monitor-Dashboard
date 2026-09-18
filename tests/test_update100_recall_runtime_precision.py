"""Regression coverage for the run-70 recall and runtime corrections."""

import social_monitor as sm
from ml.groq_semantic_gate.gate_core import evidence_grounding_status


def source() -> sm.Source:
    return sm.Source(
        enabled=True, country="Беларусь", country_code="BY", locality="", rank=1,
        priority="B", name="Тест", media_type="website", domain="test.example",
        start_url="https://test.example", language="ru",
    )


def test_china_genitive_is_rejected_without_belarus_but_local_macro_report_is_not():
    assert sm.result_integrity_genre_rejection(
        "В Китае закрывают предприятия после наводнения",
        "Власти Китая сообщили о последствиях стихии.",
    ) == "Result Integrity: foreign_without_belarus"
    assert sm.result_integrity_genre_rejection(
        "В Мозыре вырос валовой региональный продукт",
        "Динамика связана с ситуацией на российском топливном рынке.",
    ) != "Result Integrity: foreign_without_belarus"


def test_typographic_quote_variants_remain_grounded_without_fuzzy_matching():
    assert evidence_grounding_status(
        "47 семей\u202f—\u00a0без квартир…",
        "47 семей - без квартир...",
    ) == "grounded_contiguous"
    assert evidence_grounding_status(
        "Семьи лишились квартир... исполком отказал",
        "Семьи лишились квартир после перевода жилья. Исполком отказал.",
    ) == "grounded_multi_span"


def test_social_housing_reallocation_profile_is_three_anchor_only():
    text = (
        "В Мозыре 47 семей льготников стояли в очереди на жильё. "
        "Исполком перевёл квартиры в арендное жильё, и семьи остались без квартир."
    )
    assert "social_housing_reallocation" in sm.protected_public_issue_profiles(text)
    assert "social_housing_reallocation" not in sm.protected_public_issue_profiles(
        "Семья купила квартиру в новом доме и переехала."
    )


def test_accessibility_injury_profile_requires_prior_appeal():
    text = (
        "Жители Орши ранее обращались с просьбой поставить перила на лестнице, "
        "которой пользуются слабовидящие. Мужчина упал и получил травму."
    )
    assert "accessibility_hazard_after_injury" in sm.protected_public_issue_profiles(text)
    assert "accessibility_hazard_after_injury" not in sm.protected_public_issue_profiles(
        "Мужчина упал на лестнице и получил травму."
    )


def test_weather_profile_needs_repeated_damage_and_accountability():
    text = (
        "Из-за постоянных ливней гаражи в Гродно снова затапливает. "
        "Жители обращались в исполком, но проблему не решили."
    )
    assert "weather_impact_accountability" in sm.protected_public_issue_profiles(text)
    assert "weather_impact_accountability" not in sm.protected_public_issue_profiles(
        "После сильного дождя один гараж оказался в воде."
    )


def test_noise_profiles_do_not_pass_result_integrity_gate():
    assert sm.result_integrity_genre_rejection(
        "Беларусь примет председательство в международном совете",
        "Страны договорились о рабочей программе председательства.",
    ) == "Editorial Intent: международное протокольное сообщение без социальной проблемы"
    assert sm.result_integrity_genre_rejection(
        "Какие правила поездок вступят в силу в 2027 году",
        "Новые требования начнут действовать с января 2027 года.",
    ) == "Editorial Intent: будущие административные правила без текущего вреда"
    assert sm.result_integrity_genre_rejection(
        "Пенсионер рассказал, как живёт в маленькой квартире",
        "Мужчина купил жильё много лет назад и показал свой быт.",
    ) == "Result Integrity: индивидуальная частная жилищная история"

