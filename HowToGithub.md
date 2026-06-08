# How to Upload to GitHub (Git 常用指令筆記)

此專案遠端倉庫：`https://github.com/ITTAI7/Taipei-Dome-Scraper.git`

---

## 1. 檢查目前狀態

```bash
# 查看哪些檔案被修改 / 新增 / 刪除
git status

# 查看遠端倉庫設定
git remote -v

# 查看 commit 歷史
git log --oneline -10
```

---

## 2. 上傳流程（日常使用三步驟）

### Step 1：將修改的檔案加入暫存區

```bash
# 加入所有變更的檔案
git add .

# 或是只加入特定檔案
git add <檔案名稱>
```

### Step 2： Commit（提交），加上說明訊息

```bash
git commit -m "你的 commit 訊息，例如：修復台鋼爬蟲 API 問題"
```

### Step 3：Push（推送）到 GitHub

```bash
git push origin main
```

> **注意**：如果你的主分支名稱是 `master` 而不是 `main`，請改成 `git push origin master`

---

## 3. 常用其他指令

### 一次執行 add + commit（跳過 git add）

```bash
git commit -am "commit 訊息"
```

> ⚠️ 僅適用於「已追蹤」的檔案，新檔案仍需先 `git add`

### 查看本次修改了什麼

```bash
# 查看還沒 staged 的修改內容
git diff

# 查看已 staged 的修改內容
git diff --staged
```

### 放棄修改（回復到上次 commit 狀態）

```bash
# 放棄單一檔案的修改
git checkout -- <檔案名稱>

# 放棄所有修改
git checkout -- .
```

### 取消 staging（已 git add 但想退回）

```bash
git reset HEAD <檔案名稱>
```

---

## 4. 建立新分支（可選）

```bash
# 建立並切換到新分支
git checkout -b <分支名稱>

# 切換回 main 分支
git checkout main

# 查看所有分支
git branch -a
```

---

## 5. 從 GitHub 拉取最新版本

```bash
# 拉取並合併遠端最新版本
git pull origin main
```

---

## 6. 完整上傳範例

```bash
# 1. 確認目前狀態
git status

# 2. 加入所有變更
git add .

# 3. 提交
git commit -m "更新台鋼雄鷹爬蟲邏輯"

# 4. 推送到 GitHub
git push origin main
```

---

## 7. 如果 push 被拒絕 (rejected)

通常是遠端有新的 commit 你還沒拉下來：

```bash
# 先拉取遠端最新版本
git pull origin main

# 解決可能的衝突後，再 push
git push origin main
```

如果 pull 時出現 merge conflict，手動解決衝突檔案後：

```bash
git add .
git commit -m "解決合併衝突"
git push origin main
```

---

## 快速懶人包

```bash
git add . && git commit -m "更新" && git push origin main
```

三條指令一次跑完，適合小改動快速上傳。