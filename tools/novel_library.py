#!/usr/bin/env python3
"""小说参考库的入库、原文定位、学习记录及对照练习。语义工作由GPT完成。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import uuid

import novel_state as workspace


FORMAT = "novel-reference-library-v1"
PACKET_FORMAT = "novel-reference-packet-v1"
LEVELS = ("book", "arc", "scene", "prose")
READING_NOTE = "已读范围由审读者声明；哈希和引文校验只核对来源，不证明文学判断正确。"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def require_text(value, label):
    workspace.require(isinstance(value, str) and bool(value.strip()), label + "须有实际内容。")


def require_fields(value, fields):
    workspace.require(isinstance(value, dict), "记录须为对象。")
    for field in fields:
        require_text(value.get(field), field)


def load(root):
    data = workspace.read_json(Path(root) / "catalog.json")
    workspace.require(data.get("format") == FORMAT and isinstance(data.get("library_id"), str), "先初始化小说参考库。")
    return data


def save(root, catalog):
    catalog["revision"] += 1
    workspace.atomic_json(Path(root) / "catalog.json", catalog)


def initialize(root):
    with workspace.writer_lock(root):
        path = Path(root) / "catalog.json"
        if path.exists():
            return load(root)
        data = {"format": FORMAT, "library_id": str(uuid.uuid4()), "revision": 0,
                "books": {}, "studies": {}, "practices": {}, "reviews": {}}
        workspace.atomic_json(path, data)
        return data


def write_request(path, value):
    target = Path(path).resolve()
    workspace.require(not target.exists(), "输出路径已有文件，请选择新路径。")
    workspace.atomic_json(target, value)
    return {"path": str(target), "status": "pending"}


def store_record(root, catalog, collection, value):
    body = canonical(value)
    sha = workspace.digest(body)
    record_id = sha[:24]
    relative = f"{collection}/{record_id}.json"
    workspace.immutable_text(workspace.inside(root, relative), body)
    catalog[collection][record_id] = {"path": relative, "sha256": sha}
    return record_id


def record(root, catalog, collection, record_id):
    workspace.require(record_id in catalog[collection], "找不到已登记记录。")
    pin = catalog[collection][record_id]
    body = workspace.inside(root, pin["path"]).read_text(encoding="utf-8")
    workspace.require(workspace.digest(body) == pin["sha256"], "已登记的学习记录被修改。")
    return json.loads(body)


def chapter_ranges(text):
    lines = text.splitlines(keepends=True)
    heading = re.compile(r"^(?:第[零〇一二三四五六七八九十百千万两\d]+[章回节]|Chapter\s+\d+)", re.I)
    starts = [i for i, line in enumerate(lines) if heading.match(line.strip())]
    method = "chapter_headings"
    if not starts:
        method = "line_batches"
        starts = [0]
        size = 0
        for i, line in enumerate(lines):
            if size >= 8000:
                starts.append(i)
                size = 0
            size += len(line)
    elif starts[0] > 0:
        if "".join(lines[:starts[0]]).strip():
            starts.insert(0, 0)
        else:
            starts[0] = 0
    chapters = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(lines)
        body = "".join(lines[start:end])
        title = next((line.strip() for line in lines[start:end] if line.strip()), "空白前文")
        chapters.append({"chapter": index + 1, "title": title[:120], "start_line": start + 1,
                         "end_line": end, "sha256": workspace.digest(body)})
    return method, chapters


def decode_source(path):
    raw = Path(path).read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
        text = raw.decode(encoding)
    else:
        try:
            text = raw.decode("utf-8-sig")
            encoding = "utf-8-sig"
        except UnicodeDecodeError:
            text = raw.decode("gb18030")
            encoding = "gb18030"
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    workspace.require(bool(text.strip()) and "\x00" not in text, "原文为空或含二进制内容。")
    return text, encoding


def import_book(root, source, title=None, author=None, platform=None, genre=None, signed=False, signing_source=None):
    text, encoding = decode_source(source)
    sha = workspace.digest(text)
    book_id = sha[:24]
    method, chapters = chapter_ranges(text)
    with workspace.writer_lock(root):
        catalog = load(root)
        text_path = f"texts/{book_id}.txt"
        manifest = {"source_sha256": sha, "text_path": text_path, "segmentation": method,
                    "chapters": chapters}
        workspace.immutable_text(workspace.inside(root, text_path), text)
        manifest_path = f"books/{book_id}.json"
        workspace.immutable_text(workspace.inside(root, manifest_path), canonical(manifest))
        entry = dict(catalog["books"].get(book_id, {}))
        entry.update({"source_sha256": sha, "manifest_path": manifest_path,
                      "manifest_sha256": workspace.digest(canonical(manifest)),
                      "chapter_count": len(chapters)})
        for key, value in (("title", title), ("author", author), ("platform", platform), ("genre", genre)):
            entry[key] = value if value else entry.get(key, Path(source).stem if key == "title" else "")
        if signed or signing_source or "signing" not in entry:
            entry["signing"] = {"status": "author_reported" if signed else "unknown",
                                "source": signing_source or "", "submission_version": "unknown"}
        entry["input_encoding"] = encoding
        catalog["books"][book_id] = entry
        save(root, catalog)
    return {"book_id": book_id, "title": entry["title"], "chapter_count": len(chapters),
            "segmentation": method, "status": "indexed", "reading_status": "not_implied_by_import"}


def book_data(root, catalog, book_id):
    workspace.require(book_id in catalog["books"], "找不到这本参考书。")
    entry = catalog["books"][book_id]
    body = workspace.inside(root, entry["manifest_path"]).read_text(encoding="utf-8")
    workspace.require(workspace.digest(body) == entry["manifest_sha256"], "参考书分章清单被修改。")
    manifest = json.loads(body)
    text = workspace.inside(root, manifest["text_path"]).read_text(encoding="utf-8")
    workspace.require(workspace.digest(text) == entry["source_sha256"] == manifest["source_sha256"], "参考原文版本发生变化，请将新版本重新入库。")
    return manifest, text.splitlines(keepends=True)


def source_pin(root, catalog, book_id, first, last):
    manifest, _ = book_data(root, catalog, book_id)
    workspace.require(type(first) is int and type(last) is int and 1 <= first <= last <= len(manifest["chapters"]), "章节范围无效。")
    return {"book_id": book_id, "source_sha256": manifest["source_sha256"],
            "from_chapter": first, "to_chapter": last}


def check_source(root, catalog, source):
    workspace.require(isinstance(source, dict), "缺少原文来源。")
    actual = source_pin(root, catalog, source.get("book_id"), source.get("from_chapter"), source.get("to_chapter"))
    workspace.require(source == actual, "学习记录绑定的原文版本已失效。")


def read_chapter(root, book_id, chapter, start_line=None, end_line=None, max_chars=16000,
                 start_char=0, end_char=None):
    catalog = load(root)
    manifest, lines = book_data(root, catalog, book_id)
    workspace.require(type(chapter) is int and 1 <= chapter <= len(manifest["chapters"]), "章节序号无效。")
    item = manifest["chapters"][chapter - 1]
    start = item["start_line"] if start_line is None else start_line
    end = item["end_line"] if end_line is None else end_line
    workspace.require(item["start_line"] <= start <= end <= item["end_line"], "行号须在选定章节范围内。")
    workspace.require(type(max_chars) is int and 1 <= max_chars <= 80000, "单次阅读上限须为1—80000字符。")
    text = "".join(lines[start - 1:end])
    stop = len(text) if end_char is None else end_char
    workspace.require(type(start_char) is int and type(stop) is int and 0 <= start_char < stop <= len(text), "字符范围须在所选原文内，采用从0起算的左闭右开区间。")
    text = text[start_char:stop]
    workspace.require(len(text) <= max_chars, "所选范围超过阅读预算，请按行号或start-char/end-char分批读取。")
    return {"book_id": book_id, "source_sha256": manifest["source_sha256"], **item,
            "start_line": start, "end_line": end, "start_char": start_char, "end_char": stop,
            "text": text}


def evidence_check(root, catalog, source, evidence):
    workspace.require(isinstance(evidence, list) and evidence, "学习结论须附原文定位和引文。")
    manifest, lines = book_data(root, catalog, source["book_id"])
    for item in evidence:
        workspace.require(isinstance(item, dict) and type(item.get("chapter")) is int, "证据缺少章节。")
        n = item["chapter"]
        workspace.require(source["from_chapter"] <= n <= source["to_chapter"], "证据超出已声明阅读范围。")
        chapter = manifest["chapters"][n - 1]
        start, end = item.get("start_line"), item.get("end_line")
        workspace.require(type(start) is int and type(end) is int and chapter["start_line"] <= start <= end <= chapter["end_line"], "证据行号超出章节。")
        require_text(item.get("quote"), "quote")
        workspace.require(item.get("sha256") == chapter["sha256"] and item["quote"] in "".join(lines[start - 1:end]), "证据引文不存在或章节版本不符。")


def study_request(root, book_id, level, first, last, out):
    catalog = load(root)
    source = source_pin(root, catalog, book_id, first, last)
    workspace.require(level in LEVELS, "拆书层次无效。")
    if level == "book":
        workspace.require(first == 1 and last == catalog["books"][book_id]["chapter_count"], "整本分析须覆盖完整原文；部分阅读请选arc、scene或prose。")
    value = {"format": "novel-study-v1", "library_id": catalog["library_id"], "source": source,
             "level": level, "decision": "pending", "read_full_scope": False,
             "question": "", "observation": "", "interpretation": "", "technique": "",
             "applicability": "", "failure_conditions": "", "terms": [], "evidence": []}
    return write_request(out, value)


def study_check(root, path):
    value = workspace.read_json(path)
    with workspace.writer_lock(root):
        catalog = load(root)
        workspace.require(value.get("format") == "novel-study-v1" and value.get("library_id") == catalog["library_id"], "拆书记录属于其他库或格式不符。")
        check_source(root, catalog, value.get("source"))
        workspace.require(value.get("level") in LEVELS and value.get("decision") == "ready" and value.get("read_full_scope") is True, "拆书记录尚未完成实际阅读。")
        source = value["source"]
        if value["level"] == "book":
            workspace.require(source["from_chapter"] == 1 and source["to_chapter"] == catalog["books"][source["book_id"]]["chapter_count"], "整本分析缺少完整阅读范围。")
        require_fields(value, ("question", "observation", "interpretation", "technique", "applicability", "failure_conditions"))
        terms = value.get("terms")
        workspace.require(isinstance(terms, list) and terms, "写入处境、关系、阶段或情绪等有效检索词。")
        for term in terms:
            workspace.require(isinstance(term, str) and any(c.isalnum() for c in term), "检索词须包含实际文字。")
        evidence_check(root, catalog, source, value.get("evidence"))
        record_id = store_record(root, catalog, "studies", value)
        save(root, catalog)
    return {"study_id": record_id, "status": "source_checked", "note": READING_NOTE}


def catalog_status(root):
    catalog = load(root)
    books = []
    covered = {}
    for study_id in catalog["studies"]:
        study = record(root, catalog, "studies", study_id)
        source = study["source"]
        covered.setdefault(source["book_id"], set()).update(range(source["from_chapter"], source["to_chapter"] + 1))
    for book_id, entry in catalog["books"].items():
        books.append({"book_id": book_id, **entry,
                      "declared_read_chapters": len(covered.get(book_id, set()))})
    return {"library_id": catalog["library_id"], "revision": catalog["revision"], "books": books,
            "studies": len(catalog["studies"]), "practices": len(catalog["practices"]),
            "reviews": len(catalog["reviews"]), "note": READING_NOTE}


def bookmark(root, book_id, chapter, line, char, note):
    require_text(note, "阅读进度说明")
    with workspace.writer_lock(root):
        catalog = load(root)
        manifest, lines = book_data(root, catalog, book_id)
        workspace.require(type(chapter) is int and 1 <= chapter <= len(manifest["chapters"]), "阅读进度章节无效。")
        item = manifest["chapters"][chapter - 1]
        workspace.require(type(line) is int and item["start_line"] <= line <= item["end_line"], "阅读进度行号无效。")
        workspace.require(type(char) is int and 0 <= char <= len(lines[line - 1]), "阅读进度字符位置无效。")
        position = {"chapter": chapter, "next_line": line, "next_char": char, "note": note,
                    "source_sha256": manifest["source_sha256"], "kind": "reader_declared_bookmark"}
        catalog["books"][book_id]["reading_position"] = position
        save(root, catalog)
    return position


def search(root, query, platform="", genre="", level="", limit=5):
    require_text(query, "query")
    terms = [term.casefold() for term in re.split(r"[\s,，;；]+", query) if any(c.isalnum() for c in term)]
    workspace.require(terms and 1 <= limit <= 30, "使用有效检索词，结果数量须为1—30。")
    catalog = load(root)
    matches = []
    for study_id in catalog["studies"]:
        value = record(root, catalog, "studies", study_id)
        entry = catalog["books"][value["source"]["book_id"]]
        if (platform and entry["platform"] != platform) or (genre and entry["genre"] != genre) or (level and value["level"] != level):
            continue
        haystack = canonical({"study": value, "book": entry}).casefold()
        hits = [term for term in terms if term in haystack]
        if hits:
            matches.append({"study_id": study_id, "title": entry["title"], "platform": entry["platform"],
                            "genre": entry["genre"], "matched_terms": hits, "study": value})
    matches.sort(key=lambda item: (-len(item["matched_terms"]), item["study_id"]))
    return {"query": query, "indexed_studies": len(catalog["studies"]), "matching_studies": len(matches),
            "results": matches[:limit], "note": "按已完成拆书记录检索。未命中时先看catalog，选择原文阅读并补建教材。"}


def practice_request(root, book_id, through, answer_through, question, out):
    require_text(question, "question")
    catalog = load(root)
    context = source_pin(root, catalog, book_id, 1, through)
    answer = source_pin(root, catalog, book_id, through + 1, answer_through)
    value = {"format": "novel-practice-task-v1", "library_id": catalog["library_id"],
             "context": context, "answer": answer, "question": question,
             "instruction": "先读前情并保存自己的练习稿，再读后文对照；如已见过原作后文，如实记录上下文影响。"}
    return write_request(out, value)


def practice_save(root, task_path, draft_path):
    task = workspace.read_json(task_path)
    draft = Path(draft_path).read_text(encoding="utf-8")
    require_text(draft, "练习稿")
    with workspace.writer_lock(root):
        catalog = load(root)
        workspace.require(task.get("format") == "novel-practice-task-v1" and task.get("library_id") == catalog["library_id"], "练习任务格式或库身份不符。")
        check_source(root, catalog, task.get("context"))
        check_source(root, catalog, task.get("answer"))
        context, answer = task["context"], task["answer"]
        workspace.require(context["book_id"] == answer["book_id"] and context["from_chapter"] == 1 and context["to_chapter"] + 1 == answer["from_chapter"], "练习前情和原作后文范围没有接续。")
        require_text(task.get("question"), "question")
        value = {"format": "novel-practice-attempt-v1", "task": task, "draft": draft,
                 "draft_sha256": workspace.digest(draft)}
        attempt_id = store_record(root, catalog, "practices", value)
        save(root, catalog)
    return {"attempt_id": attempt_id, "draft_sha256": value["draft_sha256"], "status": "attempt_saved"}


def review_request(root, attempt_id, out):
    catalog = load(root)
    attempt = record(root, catalog, "practices", attempt_id)
    check_source(root, catalog, attempt["task"]["answer"])
    value = {"format": "novel-practice-review-v1", "library_id": catalog["library_id"],
             "attempt_id": attempt_id, "attempt_sha256": catalog["practices"][attempt_id]["sha256"],
             "decision": "pending", "mode": "same_context_approximation", "limitations": "",
             "draft_choice": "", "author_choice": "", "gap": "", "lesson": "",
             "applicability": "", "failure_conditions": "", "feedback_origin": "model", "evidence": []}
    return write_request(out, value)


def review_check(root, path):
    value = workspace.read_json(path)
    with workspace.writer_lock(root):
        catalog = load(root)
        workspace.require(value.get("format") == "novel-practice-review-v1" and value.get("library_id") == catalog["library_id"], "练习复盘格式或库身份不符。")
        attempt = record(root, catalog, "practices", value.get("attempt_id"))
        workspace.require(value.get("attempt_sha256") == catalog["practices"][value["attempt_id"]]["sha256"], "复盘对应的练习稿版本错误。")
        source = attempt["task"]["answer"]
        check_source(root, catalog, source)
        workspace.require(value.get("decision") == "ready" and value.get("mode") in ("same_context_approximation", "isolated_input"), "复盘尚未完成或未如实标明输入方式。")
        workspace.require(value.get("feedback_origin") in ("model", "author", "reader", "editor"), "标明反馈实际来自模型、作者、读者或编辑。")
        require_fields(value, ("limitations", "draft_choice", "author_choice", "gap", "lesson", "applicability", "failure_conditions"))
        evidence_check(root, catalog, source, value.get("evidence"))
        review_id = store_record(root, catalog, "reviews", value)
        save(root, catalog)
    return {"review_id": review_id, "status": "source_checked", "feedback_origin": value["feedback_origin"], "note": READING_NOTE}


validate_packet = workspace.validate_reference_packet


def export_packet(root, studies, reviews, question, out, repository_url="", commit=""):
    catalog = load(root)
    lessons = []
    for collection, ids in (("studies", studies), ("reviews", reviews)):
        for record_id in dict.fromkeys(ids):
            value = record(root, catalog, collection, record_id)
            if collection == "studies":
                source = value["source"]
                lesson, applicability, failure = value["technique"], value["applicability"], value["failure_conditions"]
            else:
                attempt = record(root, catalog, "practices", value["attempt_id"])
                source = attempt["task"]["answer"]
                lesson, applicability, failure = value["lesson"], value["applicability"], value["failure_conditions"]
            check_source(root, catalog, source)
            evidence_check(root, catalog, source, value["evidence"])
            lessons.append({"kind": "study" if collection == "studies" else "review", "id": record_id,
                            "sha256": catalog[collection][record_id]["sha256"], "lesson": lesson,
                            "applicability": applicability, "failure_conditions": failure,
                            "feedback_origin": value.get("feedback_origin", "model"),
                            "book_id": source["book_id"], "source_sha256": source["source_sha256"]})
    packet = {"format": PACKET_FORMAT, "library_id": catalog["library_id"], "library_revision": catalog["revision"],
              "origin": {"repository_url": repository_url.rstrip("/"), "commit": commit},
              "question": question, "lessons": lessons}
    validate_packet(packet)
    result = write_request(out, packet)
    return dict(result, status="exported", sha256=workspace.digest(canonical(packet)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="reference_library")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init")
    commands.add_parser("catalog")
    p = commands.add_parser("import")
    p.add_argument("--source", required=True)
    for field in ("title", "author", "platform", "genre", "signing-source"):
        p.add_argument("--" + field)
    p.add_argument("--signed", action="store_true")
    p = commands.add_parser("read")
    p.add_argument("--book", required=True)
    p.add_argument("--chapter", type=int, required=True)
    p.add_argument("--start-line", type=int)
    p.add_argument("--end-line", type=int)
    p.add_argument("--max-chars", type=int, default=16000)
    p.add_argument("--start-char", type=int, default=0)
    p.add_argument("--end-char", type=int)
    p = commands.add_parser("bookmark")
    p.add_argument("--book", required=True)
    p.add_argument("--chapter", type=int, required=True)
    p.add_argument("--next-line", type=int, required=True)
    p.add_argument("--next-char", type=int, default=0)
    p.add_argument("--note", required=True)
    p = commands.add_parser("study-request")
    p.add_argument("--book", required=True)
    p.add_argument("--level", choices=LEVELS, required=True)
    p.add_argument("--from-chapter", type=int, required=True)
    p.add_argument("--to-chapter", type=int, required=True)
    p.add_argument("--out", required=True)
    for command in ("study-check", "review-check"):
        p = commands.add_parser(command)
        p.add_argument("--file", required=True)
    p = commands.add_parser("search")
    p.add_argument("--query", required=True)
    p.add_argument("--platform", default="")
    p.add_argument("--genre", default="")
    p.add_argument("--level", choices=LEVELS, default="")
    p.add_argument("--limit", type=int, default=5)
    p = commands.add_parser("practice-request")
    p.add_argument("--book", required=True)
    p.add_argument("--through", type=int, required=True)
    p.add_argument("--answer-through", type=int, required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--out", required=True)
    p = commands.add_parser("practice-save")
    p.add_argument("--task", required=True)
    p.add_argument("--draft", required=True)
    p = commands.add_parser("review-request")
    p.add_argument("--attempt", required=True)
    p.add_argument("--out", required=True)
    p = commands.add_parser("export")
    p.add_argument("--study", action="append", default=[])
    p.add_argument("--review", action="append", default=[])
    p.add_argument("--question", required=True)
    p.add_argument("--repository-url", default="")
    p.add_argument("--commit", default="")
    p.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        if args.command == "init":
            result = initialize(args.root)
        elif args.command == "catalog":
            result = catalog_status(args.root)
        elif args.command == "import":
            source = Path(args.source)
            files = sorted(p for p in source.rglob("*") if p.is_file() and p.suffix.lower() in (".txt", ".md")) if source.is_dir() else [source]
            workspace.require(files, "目录里没有TXT或Markdown原文。")
            workspace.require(not source.is_dir() or args.title is None, "批量入库按文件名取书名；单本入库可指定title。")
            result = [import_book(args.root, path, args.title, args.author, args.platform, args.genre, args.signed, args.signing_source) for path in files]
        elif args.command == "read":
            result = read_chapter(args.root, args.book, args.chapter, args.start_line, args.end_line,
                                  args.max_chars, args.start_char, args.end_char)
        elif args.command == "bookmark":
            result = bookmark(args.root, args.book, args.chapter, args.next_line, args.next_char, args.note)
        elif args.command == "study-request":
            result = study_request(args.root, args.book, args.level, args.from_chapter, args.to_chapter, args.out)
        elif args.command == "study-check":
            result = study_check(args.root, args.file)
        elif args.command == "search":
            result = search(args.root, args.query, args.platform, args.genre, args.level, args.limit)
        elif args.command == "practice-request":
            result = practice_request(args.root, args.book, args.through, args.answer_through, args.question, args.out)
        elif args.command == "practice-save":
            result = practice_save(args.root, args.task, args.draft)
        elif args.command == "review-request":
            result = review_request(args.root, args.attempt, args.out)
        elif args.command == "review-check":
            result = review_check(args.root, args.file)
        else:
            result = export_packet(args.root, args.study, args.review, args.question, args.out, args.repository_url, args.commit)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (workspace.WorkspaceError, OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
