# Validation — Report Workspace UX corrective

Проверено:
- TS/TSX синтаксический transpile изменённых файлов: OK;
- общий hydrate CTA отсутствует в `ReportView` и `reportWorkspace`;
- состояния `full / partial / missing` поддерживаются типами и UI;
- legacy `excerpt` нормализуется в `missing`;
- ручная вставка переводит материал в `full` с origin=`manual`;
- `markExported()` и revision/exportedRevision не изменены, поэтому badge гаснет после успешного DOCX и возвращается после новой правки;
- DOCX export API и Rust-генератор не изменялись;
- SQLite schema не изменялась.
