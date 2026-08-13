from __future__ import annotations

from html import escape
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


OUT = Path("信用分体系方案_领导版.docx")


def tag(name: str, attrs: dict[str, str] | None = None, inner: str = "") -> str:
    attr = ""
    if attrs:
        attr = " " + " ".join(f'{k}="{escape(v, quote=True)}"' for k, v in attrs.items())
    return f"<{name}{attr}>{inner}</{name}>"


def r(text: str, *, bold: bool = False, color: str | None = None, size: int = 22) -> str:
    props = [
        '<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/>',
        f'<w:sz w:val="{size}"/>',
        f'<w:szCs w:val="{size}"/>',
    ]
    if bold:
        props.append("<w:b/>")
        props.append("<w:bCs/>")
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    rpr = tag("w:rPr", inner="".join(props))
    parts = []
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if i:
            parts.append("<w:br/>")
        parts.append(tag("w:t", {"xml:space": "preserve"}, escape(line)))
    return tag("w:r", inner=rpr + "".join(parts))


def p(
    text: str = "",
    *,
    style: str | None = None,
    bold: bool = False,
    color: str | None = None,
    size: int = 22,
    before: int = 0,
    after: int = 120,
    align: str | None = None,
    keep_next: bool = False,
) -> str:
    ppr_parts = [f'<w:spacing w:before="{before}" w:after="{after}" w:line="300" w:lineRule="auto"/>']
    if style:
        ppr_parts.append(f'<w:pStyle w:val="{style}"/>')
    if align:
        ppr_parts.append(f'<w:jc w:val="{align}"/>')
    if keep_next:
        ppr_parts.append("<w:keepNext/>")
    return tag("w:p", inner=tag("w:pPr", inner="".join(ppr_parts)) + r(text, bold=bold, color=color, size=size))


def heading(text: str, level: int = 1) -> str:
    if level == 1:
        return p(text, style="Heading1", bold=True, color="0F3B5F", size=32, before=360, after=120, keep_next=True)
    return p(text, style="Heading2", bold=True, color="111827", size=26, before=240, after=90, keep_next=True)


def bullet(text: str) -> str:
    return tag(
        "w:p",
        inner=tag(
            "w:pPr",
            inner='<w:pStyle w:val="ListParagraph"/><w:spacing w:before="0" w:after="70" w:line="300" w:lineRule="auto"/><w:ind w:left="420" w:hanging="220"/>',
        )
        + r("•  " + text, size=21),
    )


def cell(text: str, width: int, *, header: bool = False, center: bool = False) -> str:
    shade = '<w:shd w:fill="EAF1F8"/>' if header else ""
    v_align = '<w:vAlign w:val="center"/>'
    tcpr = tag("w:tcPr", inner=f'<w:tcW w:w="{width}" w:type="dxa"/>{shade}{v_align}<w:tcMar><w:top w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>')
    para = p(text, bold=header, color="17324D" if header else None, size=20, after=0, align="center" if center else None)
    return tag("w:tc", inner=tcpr + para)


def table(rows: list[list[str]], widths: list[int], *, center_cols: set[int] | None = None) -> str:
    center_cols = center_cols or set()
    grid = tag("w:tblGrid", inner="".join(f'<w:gridCol w:w="{w}"/>' for w in widths))
    borders = (
        '<w:tblBorders>'
        '<w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>'
        '<w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>'
        '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>'
        '<w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D6DDE7"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D6DDE7"/>'
        '</w:tblBorders>'
    )
    tblpr = tag("w:tblPr", inner='<w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>' + borders + '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>')
    trs = []
    for ridx, row in enumerate(rows):
        cells = [cell(txt, widths[i], header=(ridx == 0), center=i in center_cols) for i, txt in enumerate(row)]
        trpr = "<w:trPr><w:tblHeader/></w:trPr>" if ridx == 0 else ""
        trs.append(tag("w:tr", inner=trpr + "".join(cells)))
    return tag("w:tbl", inner=tblpr + grid + "".join(trs)) + p("", after=100)


def box(text: str, *, fill: str = "F6F9FC", border: str = "CFD8E3") -> str:
    tcpr = tag(
        "w:tcPr",
        inner=f'<w:tcW w:w="9360" w:type="dxa"/><w:shd w:fill="{fill}"/><w:tcBorders><w:top w:val="single" w:sz="8" w:color="{border}"/><w:left w:val="single" w:sz="8" w:color="{border}"/><w:bottom w:val="single" w:sz="8" w:color="{border}"/><w:right w:val="single" w:sz="8" w:color="{border}"/></w:tcBorders><w:tcMar><w:top w:w="180" w:type="dxa"/><w:left w:w="220" w:type="dxa"/><w:bottom w:w="180" w:type="dxa"/><w:right w:w="220" w:type="dxa"/></w:tcMar>',
    )
    return tag(
        "w:tbl",
        inner=tag("w:tblPr", inner='<w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/>')
        + tag("w:tblGrid", inner='<w:gridCol w:w="9360"/>')
        + tag("w:tr", inner=tag("w:tc", inner=tcpr + p(text, size=22, after=0))),
    ) + p("", after=120)


def document_xml() -> str:
    body = []
    body.append(p("信用分体系方案 V1", bold=True, color="111827", size=48, after=80))
    body.append(p("给产品与业务侧评审的简版说明", color="475467", size=26, after=40))
    body.append(p("版本：V1 草案｜目标：统一信用计算、C 位选择和奖励口径", color="667085", size=20, after=220))
    body.append(box("一句话：信用绑定官方 DealInfoNFT，而不是钱包。信用主要来自真实交易手续费贡献，低分用户和高分用户完成交易时会获得更大的额外成长；每个 NFT 维护自己交易过对象的 top5 信用快照，交易时双方候选人 PK，最高者成为 C 位并获得现有 DL 增发奖励。"))

    body.append(heading("一、核心规则"))
    body.append(table([
        ["项目", "规则"],
        ["信用载体", "只认官方 DealInfoNFT。信用跟 tokenId 走，可以随着 NFT 买卖转移。"],
        ["外部 NFT", "可以做头像、名片、资产或门禁，但不接入信用体系。"],
        ["核心分数", "V1 只有信用分 creditScore，不单独做关系分。"],
        ["信用衰减", "不衰减。信用是长期资产。"],
        ["历史旧分", "旧 totalDLMinted 不参与新信用；老 NFT 初始信用从 0 开始。"],
    ], [2300, 7060]))

    body.append(heading("二、信用分从哪里来"))
    body.append(table([
        ["来源", "是否加信用", "口径"],
        ["成功完成 deal", "是，主来源", "按本次真实手续费的 U 价值计算基础信用。"],
        ["手动 burn DL", "是", "按实际 burn 的 DL 计算，低权重，可单独调控。"],
        ["付费消息 burn DL", "可选", "默认关闭，可单独配置倍率和上限。"],
        ["域名广告真实消耗", "是", "按真实消耗的 DL 计算，不按充值额计算。"],
        ["域名注册 / InfoNFT mint", "是", "低权重，有生命周期上限。"],
        ["swap fee burn", "预留", "作为 action 保留，默认关闭。"],
        ["创建 deal、免费消息、失败/取消交易", "否", "V1 不加分，也暂不扣分。"],
    ], [2800, 1700, 4860], center_cols={1}))

    body.append(heading("三、交易信用计算"))
    body.append(p("交易信用由两部分组成：基础贡献分和额外奖励分。"))
    body.append(box("最终获得信用分 = 基础贡献分 + 额外奖励分\n基础贡献分 = 本次手续费的 U 价值\n额外奖励分 = 基础贡献分 × 信用差系数\n信用差系数 = 对方信用分 ÷ 自己信用分，限制在 0.01 到 2", fill="F4F7FF", border="B8C7FF"))
    body.append(p("也就是说，交易先按照真实手续费贡献给基础信用；然后再根据双方信用差，给低分方更多成长空间。"))

    body.append(heading("四、数字例子"))
    body.append(table([
        ["条件", "数值"],
        ["A 信用分", "10000"],
        ["B 信用分", "200"],
        ["交易金额", "10000U"],
        ["手续费率", "0.3%"],
        ["基础贡献分", "10000U × 0.3% = 30 分"],
    ], [2600, 6760]))
    body.append(table([
        ["用户", "额外奖励系数", "额外奖励", "本次总获得"],
        ["A 高分方", "200 ÷ 10000 = 0.02", "30 × 0.02 = 0.6", "30 + 0.6 = 30.6"],
        ["B 低分方", "10000 ÷ 200 = 50，封顶为 2", "30 × 2 = 60", "30 + 60 = 90"],
    ], [1900, 3100, 2100, 2260]))
    body.append(box("含义：高分方完成真实交易，至少获得基础贡献分；低分方如果和高分方完成真实交易，会获得更大的信用成长。", fill="FFF8E7", border="F0C36A"))

    body.append(heading("五、0 分处理"))
    body.append(table([
        ["自己信用", "对方信用", "额外奖励系数"],
        ["0", "0", "0"],
        ["0", "大于 0", "2"],
        ["大于 0", "0", "0"],
        ["大于 0", "大于 0", "对方 ÷ 自己，限制在 0.01 到 2"],
    ], [2300, 2300, 4760], center_cols={0, 1, 2}))

    body.append(heading("六、top5 信用快照"))
    body.append(p("每个官方 NFT 维护自己交易过对象中的 top5 信用快照。"))
    body.append(box("成功交易后：\nA 记录/刷新 B 的信用快照\nB 记录/刷新 A 的信用快照\n\n对方在别处涨分，不会自动刷新到我这里。\n只有我们再次成功交易，快照才更新。", fill="FBFCFE"))
    body.append(p("这个设计可以防止一个高信用 NFT 自动进入所有人的信用网络。"))

    body.append(heading("七、C 位奖励"))
    body.append(p("C 位就是本次交易双方信用网络里 PK 出来的最强信用人。"))
    body.append(box("A 侧候选：A 自己当前信用分；A 的 top5 里最高信用快照\nB 侧候选：B 自己当前信用分；B 的 top5 里最高信用快照\n\nA 侧最高者 vs B 侧最高者\n分高者成为 C；平局没有 C", fill="FBFCFE"))
    body.append(p("V1 先保留现有 C 位奖励方式：继续通过增发 DL 奖励，不从真实手续费里切分。新信用体系第一版主要替换“C 是谁”，暂时不改变 C 奖励来源和额度。"))

    body.append(heading("八、防刷规则"))
    body.append(bullet("同一个 owner 持有的两个官方 NFT 互相交易：不加信用、不刷新 top5、不产生 C 位。"))
    body.append(bullet("没有官方 DealInfoNFT 的用户可以交易，但不加信用、不进入 top5、不参与 C 位。"))
    body.append(bullet("外部 NFT 不接信用体系，只能做展示、资产或门禁。"))
    body.append(bullet("非交易行为都有单独倍率和上限，防止通过 burn 或消息低成本刷分。"))

    body.append(heading("九、当前结论"))
    body.append(box("V1 的重点不是做复杂关系分，而是建立一个清晰的信用资产体系：信用跟官方 NFT 走，主要由真实交易贡献产生；低分用户通过和高分用户完成真实交易获得更快成长；交易时双方信用网络选出 C 位，奖励沿用现有 DL 增发机制。"))

    sect = (
        '<w:sectPr>'
        '<w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>'
        '</w:sectPr>'
    )
    body.append(sect)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:o="urn:schemas-microsoft-com:office:office" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
        'xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:w10="urn:schemas-microsoft-com:office:word" '
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
        'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" '
        'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" '
        'xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" '
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'mc:Ignorable="w14 wp14"><w:body>'
        + "".join(body)
        + "</w:body></w:document>"
    )


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"""

STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:rPr>
      <w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="0F3B5F"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="111827"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>"""


def main() -> None:
    if OUT.exists():
        OUT.unlink()
    with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
        z.writestr("word/document.xml", document_xml())
        z.writestr("word/styles.xml", STYLES)
    print(OUT)


if __name__ == "__main__":
    main()
