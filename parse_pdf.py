#!/usr/bin/env python3
"""
Parser for Journal Officiel EDN/ECN affectation PDFs (e.g. 2026.pdf -> 2026.json).
Extracts text directly from PDF FlateDecode content streams and ToUnicode CMaps.
"""
import json
import re
import sys
import zlib

CHU_MAP = {
    "au CHU d'Amiens": "AMIENS",
    "au CHU d’Amiens": "AMIENS",
    "au CHU d'Angers": "ANGERS",
    "au CHU d’Angers": "ANGERS",
    "à l’Assistance publique des hôpitaux de Marseille": "AP-HM Marseille",
    "à l’Assistance publique des hôpitaux de Marseille/Corse": "AP-HM Marseille",
    "à l’Assistance publique-hôpitaux de Paris": "AP-HP Paris",
    "au CHU de Besançon": "BESANCON",
    "au CHU de Bordeaux": "BORDEAUX",
    "au CHU de Brest": "BREST",
    "au CHU de Caen": "CAEN",
    "au CHU de Clermont-Ferrand": "CLERMONT-FERRAND",
    "au CHU de Dijon": "DIJON",
    "au CHU de Grenoble": "GRENOBLE",
    "aux Hospices Civils de Lyon": "HCL Lyon",
    "aux Hospices civils de Lyon": "HCL Lyon",
    "au CHU de La Réunion": "LA REUNION",
    "au CHU de Lille": "LILLE",
    "au CHU de Limoges": "LIMOGES",
    "au CHU de la Martinique/CHU de la Guadeloupe": "MARTINIQUE/POINTE A PITRE",
    "au CHU de la Martinique/ -CHU de la Guadeloupe": "MARTINIQUE/POINTE A PITRE",
    "au CHU de la Martinique/-CHU de la Guadeloupe": "MARTINIQUE/POINTE A PITRE",
    "au CHU de Montpellier": "MONTPELLIER",
    "au CHU de Nancy": "NANCY",
    "au CHU de Nantes": "NANTES",
    "au CHU de Nice": "NICE",
    "au CHU de Poitiers": "POITIERS",
    "au CHU de Reims": "REIMS",
    "au CHU de Rennes": "RENNES",
    "au CHU de Rouen": "ROUEN",
    "au CHU de Saint-Etienne": "SAINT ETIENNE",
    "au CHU de Strasbourg": "STRASBOURG",
    "au CHU de Toulouse": "TOULOUSE",
    "au CHU de Tours": "TOURS",
}


def decode_pdf_string(s_bytes, cmap):
    out = []
    i = 0
    n = len(s_bytes)
    while i < n:
        b = s_bytes[i]
        if b == 92:  # backslash
            i += 1
            if i >= n:
                break
            esc = s_bytes[i]
            if esc == ord("n"):
                code = 10
            elif esc == ord("r"):
                code = 13
            elif esc == ord("t"):
                code = 9
            elif esc == ord("b"):
                code = 8
            elif esc == ord("f"):
                code = 12
            elif esc in (ord("("), ord(")"), ord("\\")):
                code = esc
            elif 48 <= esc <= 55:
                oct_s = bytes([esc])
                for _ in range(2):
                    if i + 1 < n and 48 <= s_bytes[i + 1] <= 55:
                        i += 1
                        oct_s += bytes([s_bytes[i]])
                    else:
                        break
                code = int(oct_s, 8)
            else:
                code = esc
            out.append(cmap.get(code, chr(code)))
        else:
            out.append(cmap.get(b, chr(b)))
        i += 1
    return "".join(out)


def parse_pdf_to_records(pdf_path):
    with open(pdf_path, "rb") as f:
        raw = f.read()

    objs = {}
    streams = {}
    for m in re.finditer(rb"(\d+)\s+0\s+obj\b(.*?)endobj", raw, re.DOTALL):
        oid = int(m.group(1))
        body = m.group(2)
        objs[oid] = body
        sm = re.search(rb"stream\r?\n(.*?)\r?\nendstream", body, re.DOTALL)
        if sm:
            try:
                d = zlib.decompress(sm.group(1))
            except Exception:
                d = sm.group(1)
            streams[oid] = d
            if b"/ObjStm" in body:
                first = int(re.search(rb"/First\s+(\d+)", body).group(1))
                n = int(re.search(rb"/N\s+(\d+)", body).group(1))
                header = d[:first].decode("latin1").split()
                pairs = [(int(header[2 * i]), int(header[2 * i + 1])) for i in range(n)]
                for idx, (sub_oid, offset) in enumerate(pairs):
                    end_off = pairs[idx + 1][1] if idx + 1 < n else len(d) - first
                    objs[sub_oid] = d[first + offset : first + end_off]

    font_cmaps = {}
    for oid, body in objs.items():
        m = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", body)
        if m:
            u_oid = int(m.group(1))
            text = streams[u_oid].decode("latin1")
            mapping = {}
            for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.DOTALL):
                for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
                    mapping[int(src, 16)] = "".join(
                        chr(int(dst[i : i + 4], 16)) for i in range(0, len(dst), 4)
                    )
            for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.DOTALL):
                for line in block.strip().splitlines():
                    m_r = re.match(
                        r"\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>",
                        line,
                    )
                    if m_r:
                        s, e, dst = (
                            int(m_r.group(1), 16),
                            int(m_r.group(2), 16),
                            int(m_r.group(3), 16),
                        )
                        for c in range(s, e + 1):
                            mapping[c] = chr(dst + (c - s))
            font_cmaps[oid] = mapping

    root_pages = None
    for oid, body in objs.items():
        if re.search(rb"/Type\s*/Catalog\b", body):
            m = re.search(rb"/Pages\s+(\d+)\s+0\s+R", body)
            if m:
                root_pages = int(m.group(1))

    page_oids = []

    def visit(node_oid):
        body = objs[node_oid]
        if re.search(rb"/Type\s*/Page\b", body):
            page_oids.append(node_oid)
        else:
            m_kids = re.search(rb"/Kids\s*\[(.*?)\]", body, re.DOTALL)
            if m_kids:
                for km in re.finditer(rb"(\d+)\s+0\s+R", m_kids.group(1)):
                    visit(int(km.group(1)))

    visit(root_pages)

    all_lines = []
    for p_oid in page_oids:
        body = objs[p_oid]
        c_oid = int(re.search(rb"/Contents\s+(\d+)\s+0\s+R", body).group(1))
        r_oid = int(re.search(rb"/Resources\s+(\d+)\s+0\s+R", body).group(1))
        f_map = {
            fm.group(1).decode("latin1"): font_cmaps.get(int(fm.group(2)), {})
            for fm in re.finditer(rb"/(F\d+)\s+(\d+)\s+0\s+R", objs[r_oid])
        }
        cur_cmap = {}
        cur_line = []
        for raw_line in streams[c_oid].splitlines():
            m_tf = re.match(rb"/(F\d+)\s+\S+\s+Tf", raw_line)
            if m_tf:
                cur_cmap = f_map.get(m_tf.group(1).decode("latin1"), {})
                continue
            m_td = re.match(rb"(\S+)\s+(\S+)\s+Td", raw_line)
            if m_td:
                if abs(float(m_td.group(2))) > 0.1 and cur_line:
                    all_lines.append("".join(cur_line).strip())
                    cur_line = []
                continue
            if raw_line == b"ET" and cur_line:
                all_lines.append("".join(cur_line).strip())
                cur_line = []
                continue
            if raw_line.endswith(b"Tj"):
                m_s = re.match(rb"\((.*)\)Tj$", raw_line, re.DOTALL)
                if m_s:
                    cur_line.append(decode_pdf_string(m_s.group(1), cur_cmap))
            elif raw_line.endswith(b"TJ"):
                for m_s in re.finditer(rb"\((?:\\.|[^\\()])*\)", raw_line):
                    cur_line.append(decode_pdf_string(m_s.group(0)[1:-1], cur_cmap))
        if cur_line:
            all_lines.append("".join(cur_line).strip())

    entries = []
    cur = None
    for line in all_lines:
        if not line or line in (
            "Décrets, arrêtés, circulaires",
            "MESURES NOMINATIVES",
            "JOURNAL OFFICIEL DE LA RÉPUBLIQUE FRANÇAISE",
        ):
            continue
        if re.match(r"^\d+\s+octobre\s+\d{4}$", line) or re.match(
            r"^Texte\s+\d+\s+sur\s+\d+$", line
        ):
            continue
        if line.startswith("Groupe de spécialités") or line.startswith(
            "Chirurgie orale -"
        ):
            cur = None
            continue
        if re.match(r"^\d+\.\s+(M\.|Mme)\s+", line):
            if cur:
                entries.append(cur)
            cur = line
        elif cur is not None:
            cur = (cur + line) if cur.endswith("-") else (cur + " " + line)
        if cur and cur.endswith("."):
            entries.append(cur)
            cur = None
    if cur:
        entries.append(cur)

    pat = re.compile(
        r"^(\d+)\.\s+(M\.|Mme)\s+([^(]+?)\s*\(([^)]+)\)"
        r"(?:,\s*(?:Usage|Épouse|Epouse|Époux|Epoux|Nom d’usage|Nom d’épouse|Nom d’nom d’usage|Nom d’nom d’épouse)\s+[^,]+)?"
        r",\s+(.+?)\s+(au CHU [^.]+|à l’Assistance [^.]+|aux Hospices [^.]+)\.$"
    )
    records = []
    for e in entries:
        m = pat.match(e)
        if not m:
            raise ValueError(f"Failed to match: {e}")
        rank = int(m.group(1))
        civ = m.group(2)
        last_name = m.group(3).strip()
        first_names = [fn.strip() for fn in m.group(4).split(",") if fn.strip()]
        spec = m.group(5).strip().replace("cardiovascu -laire", "cardiovasculaire")
        chu_raw = m.group(6).strip()
        chu = CHU_MAP[chu_raw]
        records.append(
            {
                "rank": rank,
                "civility": civ,
                "last_name": last_name,
                "first_names": first_names,
                "specialty": spec,
                "city_hospital": chu,
            }
        )
    records.sort(key=lambda r: r["rank"])
    return records


if __name__ == "__main__":
    pdf_file = sys.argv[1] if len(sys.argv) > 1 else "2026.pdf"
    out_file = sys.argv[2] if len(sys.argv) > 2 else "2026.json"
    recs = parse_pdf_to_records(pdf_file)
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(recs, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(recs)} records from {pdf_file} to {out_file}")
