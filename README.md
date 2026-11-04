# 공부 기록 사이트

비공개 글 저장소([`secretj/study-notes`](https://github.com/secretj/study-notes))를 트리·태그·연도로 보여 주고, 브라우저에서 바로 쓰고·고치고·지우고·올리는 페이지예요.

- 주소: https://secretj.github.io/study-notes-site/
- 이 저장소에는 **사이트 코드만** 있어요. 글은 한 줄도 없어요.
- 들어갈 때 GitHub fine-grained 토큰(글 저장소 하나, Contents: Read and write)을 넣어요. 토큰은 그 브라우저의 localStorage 에만 저장되고, GitHub API 말고 다른 곳으로 보내지 않아요.

## 동작

- 읽기: `git/trees?recursive=1` 로 파일 목록을 받고, 글·그림은 `git/blobs` 로 받아 브라우저에서 그려요.
- 쓰기: 저장·삭제·올리기·이름 바꾸기 모두 Git Data API(blob → tree → commit → ref) 로 **커밋 한 번**에 처리해요.
- 분류: 글 저장소의 `index.json`(제목·날짜·태그)을 읽어요. 사이트가 글을 바꿀 때 `index.json` 도 같은 커밋에서 고쳐요. 형식은 글 저장소 `tools/build_index.py` 와 똑같이 맞춰서, Actions 가 다시 만들어도 diff 가 없어요.

## 로컬에서 시험하기

```sh
python3 test/mock_github.py ../study-notes 8765   # 가짜 GitHub API (토큰: test-token)
python3 -m http.server 8000
# http://localhost:8000/?api=http://localhost:8765 를 열고 토큰 칸에 test-token
```

mock 은 글 저장소의 git HEAD 로 시작하고 메모리에서만 바뀌어요. 실제 저장소는 건드리지 않아요.

## 라이브러리

`vendor/` 에 고정 버전을 넣어 뒀어요. 실행 중에 외부 CDN 을 부르지 않아요.

- marked 15.0.12 (MIT)
- DOMPurify 3.2.6 (Apache-2.0 / MPL-2.0)
