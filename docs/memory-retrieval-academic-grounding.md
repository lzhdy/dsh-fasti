# 检索问题与学术界既有研究的对照

> 日期：2026-11-16
> 目的：把本仓遇到的三个检索失效（2 字词、短词/长句不匹配、语义鸿沟）对照学术界成熟研究，判断哪些能直接借、哪些被本仓纪律排除、哪些需要重新拍板。
> 方法：文献检索 + 关键结论回原文核对，不转述二手解读。

---

## 1. 三个问题在学界叫什么

| 我们观察到的现象 | 学界名称 | 是否有成熟解法 |
|---|---|---|
| 「成都」「奶茶」这类 2 字词在 trigram 索引下恒 0 候选 | CJK 索引单位选择（indexing unit / n-gram vs word） | **有，且是已定论的老问题** |
| 用户整句问法与库里叙述句只有 2 字重叠 | 词表不匹配（vocabulary mismatch） | **有，标准解法是文档侧扩展** |
| 「锁库」vs `database is locked`、「长满一半」vs「长到一半」字面不重叠 | 语义鸿沟（semantic gap） | 有，靠向量/语义表示，但成本高 |
| 短查询撞长记录 | 段落级检索（passage retrieval） | 有，经典方向 |

---

## 2. 关键证据逐条

### 2.1 CJK 检索的标准索引单位是 **bigram（2 字符）**，不是 trigram

NTCIR-4 的 CJK 检索实验（Tomlinson, Hummingbird SearchServer）明确写明：

- "The n-gram approach used **bigrams** for most Asian text."
- "the differences of n-grams and (decompounded) words in mean average precision were **not statistically significant** for any of the 3 languages"——即 **bigram 索引与最优秀的分词方案效果相当**，不需要分词器。
- 该文还转述了既有共识：中文"prefers **short-words** to long-words"。
- 复合词拆分（decompounding）对中文有提升：Topic 7 把"巴拿马运河"拆成"巴拿马"/"运河"后，相关文档因为只提其中一个词而原本漏召，拆分后 AP 提升 38 点。

**对本仓的直接含义**：`MIN_TRIGRAM_LENGTH=3` + `tokenize='trigram'` 这个组合**结构性地无法索引任何 2 字词**，而 2 字词恰恰是中文最核心的检索单位（城市、人名、品类）。这不是参数没调好，是**索引单位选错了**。换成 bigram 索引，2 字词天然可查，且不需要引入分词依赖，与"零外部依赖"纪律相容。

代价（该文同样指出）：n-gram 索引体积更大、检索开销更高，且可能出现常见词过度匹配（Topic 22 的 Kia Motors 案例），需要用 IDF/df 加权抑制。

> 出处：https://research.nii.ac.jp/ntcir/workshop/OnlineProceedings4/CLIR/NTCIR4-CLIR-TomlinsonS.pdf
> 相关：Nie & Ren, "Chinese information retrieval: using characters or words?", IP&M 1999；Foo & Li, "Chinese word segmentation and its effect on IR", IP&M 2004；Luk & Kwok, "A Comparison of Chinese Document Indexing Strategies and Retrieval Models", TALIP 2003。

### 2.2 词表不匹配：**扩文档比扩查询有效**，且查询扩展可能有害

doc2query（Nogueira, Yang, Lin, Cho, 2019）的核心实验结论：

- 做法：写入时用模型预测"哪些查询会被用来找这份文档"，把这些预测词追加进文档索引；BM25 + doc2query 在两个数据集上**提升约 15%**，MS MARCO Recall@1000 从 **85.3 → 89.3**。
- 拆解：扩展词中 69% 是从原文档复制的词（等于**给关键术语重新加权**），31% 是原文档没有的新词（同义/相关扩展）；只用新词 MRR@10 18.8，只用复制词 19.7，两者合用 21.5，**互补**。
- 反向对照：**"query expansion with RM3 hurts in both datasets"**——查询侧扩展在两个数据集上都**变差**。原文给的解释是："document expansion can be more effective than query expansion, most likely because **there are more signals to exploit as documents are much longer**."

**对本仓的直接含义**：这与我们第 0 步实测完全对齐——P0′（模型改写/扩展查询）只中 2/16，几乎无效；而信息量在"记录"一侧（cue 是长句），扩记录侧才有空间。评审一 J-2（写入侧让摘要环顺带产词）不是拍脑袋，是这一支线的标准做法；而评审一 J-3 / 评审三 PF-4（让宿主模型改写查询）恰好是被该文证否的方向。

> 出处：https://arxiv.org/pdf/1904.08375
> 后续：Ma et al., "Document Expansions and Learned Sparse Lexical Representations for MS MARCO V1 and V2", SIGIR 2022。

### 2.3 记忆检索的学界标杆：recency + importance + relevance 三项等权

Generative Agents（Park et al., UIST 2023）的记忆流检索：

- `score = α_recency·recency + α_importance·importance + α_relevance·relevance`，三者 **min-max 归一化到 [0,1]**，α 全部取 1。
- recency：指数衰减，衰减因子 0.995（按经过的小时数），且作用于"**最近一次被访问**"的时间戳，不只是创建时间。
- importance：**在记忆对象创建时由 LLM 打 1–10 分并冻结**（"The importance score is generated at the time the memory object is created"）。这是写入侧产结构化信号，不是运行期抽取。
- relevance：用 embedding 余弦相似度。

**对本仓的直接含义**：
1. 我们的 `LAMBDA=0.15` 只是 recency 一项的权重，且以"发生时间"而非"最近访问时间"计衰减；学界是三项等权归一，且**有 importance 这一维**。记录的重要性分层目前完全缺失。
2. "写入时让模型产一个结构化信号并存进事件"是学界标准动作，不构成对"确定性派生"精神的背叛——但它确实是契约变更，需要显式拍板。
3. relevance 用向量。我们没有向量，这条被纪律排除（见第 3 节）。

> 出处：https://arxiv.org/pdf/2304.03442

### 2.4 短查询撞长记录：段落级检索是经典解法

Salton/Allan/Buckley (SIGIR 1993)、Callan (SIGIR 1994)、Kaszkiel & Zobel (SIGIR 1997 / JASIST 2001) 一系列工作确立：长文档检索用**段落级索引 + 段落证据聚合**优于整篇匹配，因为查询通常只与文档的一小段相关。

**对本仓的直接含义**：我们已经在做一半——`cue` 本质上就是把事件切成"段落"。缺的是另一半：查询与 cue 之间仍是"整串子串"匹配，而不是段落级相似度打分。P3s（把查询切片段去撞 cue）在思路上是对的，只是方向反了：学界是**把文档切细**，我们是把查询切碎。

---

## 3. 被本仓纪律排除的选项（需要用户拍板才可能解禁）

| 选项 | 学术地位 | 为什么现在不能用 |
|---|---|---|
| 稠密向量检索 / embedding 余弦 | 当前 relevance 的主流做法（Generative Agents 即用此） | 纪律：零外部依赖、单层召回、无向量混排（K10）；且引入模型与索引体积 |
| 学习型稀疏（SPLADE 等） | 介于词面与向量之间，效果接近稠密 | 同上，需模型推理 |
| 中文分词器（jieba 等） | 与 bigram 效果相当 | 不必要——bigram 已可达到同等效果，且零依赖 |
| 查询扩展 / RM3 | 在 precision 场景**有害**（doc2query 实证） | 已被我们自己实测证否（2/16） |

结论：**唯一"高效且零依赖"的三条路是 bigram 索引、文档侧词扩展、重要性分层**，其余都要么需要外部模型，要么已被证据否掉。

---

## 4. 据学术证据修订的技术判断

| 原判断 | 学术对照后 | 变化 |
|---|---|---|
| cue 应改成纯关键词 | doc2query 证明"记录包含更多词"是优势；把 cue 砍短会减少可匹配信号 | **反向修正**：保留叙述 cue，另外**追加**预测词，而不是替换 |
| trigram 只是"参数问题" | 索引单位选错，bigram 是 CJK 标准 | **升级为设计缺陷**，属必修 |
| 门方向是核心 | 段落级检索才是框架问题 | 门只是末端的收口，不是主战场 |
| 记录不分轻重 | importance 是学界三要素之一 | **新增缺口**：我们的检索没有重要性维度 |
| 写入侧产词是"契约变更风险" | 是学界标准动作（Generative Agents / doc2query 皆如此） | **风险降级**，但仍需拍板 |

---

## 5. 离线验证结果（2026-11-16 已跑，生产码零改动）

探针：`tests/memory/bigram-probe.ts`（untracked）。数据：`cue-arm-bench.ts` 里 8 桥段真模型产物（逐字取自真跑日志，零重造），cue 走真实 `deriveCuesFromKeyPoints`。同一内存库内同时建生产 trigram 投影与自建 bigram 投影（FTS5 `unicode61`，索引文本为应用层预切的 bigram 序列）。

| 口径 | 索引 | 召回 | 备注 |
|---|---|---|---|
| T 整句问法（生产现状） | trigram | **0/16** | 基线 |
| B1 整句问法 | bigram | **0/16** | bigram 不改变整句问题，与预期一致 |
| T3 oracle 短词（生产现状） | trigram | **9/25** | 2 字词结构性归零 |
| B3 oracle 短词 | bigram | **22/25** | 2 字词直接可查 |
| B4 oracle 短词 | bigram+unigram | **23/25** | 补上单字词缺口（「冰」） |
| B2 整句→片段枚举（≥2 片段交叉） | bigram | 13/16 | 误召 0；交叉阈值未调优，属过严 |
| B2′ 整句→片段枚举（任一片段） | bigram | **16/16** | 误召 2（对齐 P3s 口径） |

**结论一：bigram 索引把 oracle 短词从 9/25 提到 22/25，加 unigram 双写后 23/25——与"全表扫描 + oracle 短词"(P2s′: 23/25) 完全持平，但它是可索引的。** 学术结论在本仓真实数据上复现。

**结论二：bigram 单独不解决整句问法（0/16 → 0/16）。** 索引单位与"匹配几何"是两件正交的事，必须配读出侧片段枚举。

**结论三：bigram 索引让片段枚举的精度反而更好。** 同口径对比：全表扫描 P3s 16/16 误召 6、P3d 16/16 误召 4；bigram 索引 B2′ 16/16 误召 **2**。原因：bigram phrase 匹配天然要求片段内字符相邻，比裸子串包含更强，判别力更高。

**代价**：索引文本体积膨胀 **1.95×**（239 → 467 字符）。

**剩余 2 条失败仍是真语义鸿沟**：`锁库` vs cue 里的 `database is locked`；`长满一半` vs cue 里的 `长到一半`。这两条词面索引永远解决不了，只能靠向量或人工别名。

### 5.1 落地形态更正（此前判断有误）

前文曾说"只动 `schema.ts` 的 tokenizer 策略与 `MIN_TRIGRAM_LENGTH`"——**这不成立**。SQLite FTS5 的 `trigram` tokenizer 固定切 3 字符，**没有内置 bigram tokenizer**，无法靠改参数得到 2 字符索引。可行落地是**应用层预切分**：

1. 写入侧：`fts.ts::cueTextOf` 的输出先过 bigram 化（CJK 相邻两字 + ASCII 整词，末尾追加 CJK 单字），再写入 FTS 文本列；
2. 查询侧：`bm25.ts` 把查询同样 bigram 化并用 phrase 包裹，走 `MATCH`；进入 FTS 的阈值从 3 码点降到 2 码点；
3. 复核：`matchesSubstring` 的语义不变，但对**原文**复核（原文可从 `mem_card.display_cues_json` 取，无需新增列）；
4. 全库重建一次（生产库当前仅 2 张卡，代价近零）；
5. `MEMORY_SCHEMA_VERSION` 是否升版需单独裁定（FTS 文本语义变了，属于"同版不同义"的风险点）。

## 6. 尚未查清、需要在真实规模上验证的

1. ~~bigram 在 SQLite 下的实现方式与体积代价~~ —— 已测：应用层预切分可行，体积 1.95×。
2. doc2query 式"预测词"在中文小规模记忆库上是否值得（该结论来自万级文档的 web 检索，我们对 10²–10⁴ 条记忆是否同样有效，需实测）。
3. importance 分由 LLM 在写入时产出，会带来一次额外模型调用；与本仓"读数只在闭合时发生"的预算是否冲突，需核。
4. 段落级相似度（不要求连续子串）能否在零依赖下用 BM25 over cue 实现，替代"片段子串匹配"。
