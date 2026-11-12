import { assert, test } from 'orca/testing'
import { parseDiff } from './diff.ts'

const DIFF = `diff --git a/app/a.rb b/app/a.rb
index 1111111..2222222 100644
--- a/app/a.rb
+++ b/app/a.rb
@@ -1,6 +1,6 @@ module A
 one
-two
+TWO
 three
 four
-five
+FIVE
 six
diff --git a/old name.rb b/new name.rb
similarity 90%
rename from old name.rb
rename to new name.rb
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/gone.rb b/gone.rb
deleted file mode 100644
--- a/gone.rb
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
`

test('splits hunks into separate changes with line numbers', () => {
  const [a] = parseDiff(DIFF)
  assert.equal(a.path, 'app/a.rb')
  assert.equal(a.status, 'modified')
  assert.equal(a.additions, 2)
  assert.equal(a.deletions, 2)
  assert.equal(a.hunks[0].changes.length, 2)
  const added = a.hunks[0].lines.find((l) => l.s === 'FIVE')
  assert.deepEqual([added?.o, added?.n], [null, 5])
})

test('reads renames, binary and deleted files', () => {
  const files = parseDiff(DIFF)
  assert.deepEqual(files.slice(1).map((f) => [f.path, f.oldPath, f.status, f.binary]), [
    ['new name.rb', 'old name.rb', 'renamed', false],
    ['img.png', null, 'added', true],
    ['gone.rb', null, 'deleted', false]
  ])
})

test('change keys stay the same when only line numbers move', () => {
  const [a] = parseDiff(DIFF)
  const [shifted] = parseDiff(DIFF.replace('@@ -1,6 +1,6 @@', '@@ -11,6 +11,6 @@'))
  assert.deepEqual(
    shifted.hunks[0].changes.map((c) => c.key),
    a.hunks[0].changes.map((c) => c.key)
  )
  assert.equal(shifted.hash, a.hash)
})
