;; pcm(x, n, nch, y, bytes): decode-wav.js's integer PCM, n frames of nch interleaved little-endian samples of 2, 3 or 4
;; bytes at x, each channel's n float32 at y + c·n·4: a sample's code over 2^15, 2^23, 2^31, as decodeRaw() divides it.
;; Exact for 16 and 24 bits (the code times a power of two); for 32 bits the code rounded to float32, then scaled by a
;; power of two, which rounds as the quotient does: the same bits. 16-bit mono and stereo eight samples a step, the
;; rest one sample a step; a 24-bit sample read as the four bytes from it, the byte after it shifted out.
;; wat2wasm pcm.wat -o - | node -e "process.stdin.on('data', b => console.log([...b].join(',')))"
(module
  (memory (export "memory") 1)
  (func (export "pcm") (param $x i32) (param $n i32) (param $nch i32) (param $y i32) (param $b i32)
    (local $i i32) (local $c i32) (local $e i32) (local $p i32) (local $z i32) (local $v v128) (local $k v128) (local $s f32)
    (local.set $z (i32.shl (local.get $n) (i32.const 2)))
    (local.set $k (v128.const f32x4 0x1p-15 0x1p-15 0x1p-15 0x1p-15))
    (if (i32.eq (local.get $b) (i32.const 2)) (then
      (if (i32.eq (local.get $nch) (i32.const 2)) (then
        ;; four frames a step: L0 R0 L1 R1 L2 R2 L3 R3 as L0..L3 R0..R3
        (local.set $e (i32.and (local.get $n) (i32.const -4)))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $i) (local.get $e)))
          (local.set $v (i8x16.shuffle 0 1 4 5 8 9 12 13 2 3 6 7 10 11 14 15 (v128.load (local.get $x)) (local.get $v)))
          (v128.store (local.get $y) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $v))) (local.get $k)))
          (v128.store (i32.add (local.get $y) (local.get $z)) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $v))) (local.get $k)))
          (local.set $x (i32.add (local.get $x) (i32.const 16)))
          (local.set $y (i32.add (local.get $y) (i32.const 16)))
          (local.set $i (i32.add (local.get $i) (i32.const 4)))
          (br $l)))))
      (if (i32.eq (local.get $nch) (i32.const 1)) (then
        (local.set $e (i32.and (local.get $n) (i32.const -8)))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $i) (local.get $e)))
          (local.set $v (v128.load (local.get $x)))
          (v128.store (local.get $y) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $v))) (local.get $k)))
          (v128.store offset=16 (local.get $y) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $v))) (local.get $k)))
          (local.set $x (i32.add (local.get $x) (i32.const 16)))
          (local.set $y (i32.add (local.get $y) (i32.const 32)))
          (local.set $i (i32.add (local.get $i) (i32.const 8)))
          (br $l)))))))
    (local.set $s (select (f32.const 0x1p-15) (select (f32.const 0x1p-23) (f32.const 0x1p-31) (i32.eq (local.get $b) (i32.const 3))) (i32.eq (local.get $b) (i32.const 2))))
    ;; the rest a sample at a time: frame i, channel c to y + c·n·4 + i·4
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $c (i32.const 0))
      (local.set $p (local.get $y))
      (loop $ch
        (f32.store (local.get $p) (f32.mul (local.get $s) (f32.convert_i32_s
          (if (result i32) (i32.eq (local.get $b) (i32.const 2)) (then (i32.load16_s (local.get $x)))
            (else (if (result i32) (i32.eq (local.get $b) (i32.const 3)) (then (i32.shr_s (i32.shl (i32.load (local.get $x)) (i32.const 8)) (i32.const 8)))
              (else (i32.load (local.get $x)))))))))
        (local.set $x (i32.add (local.get $x) (local.get $b)))
        (local.set $p (i32.add (local.get $p) (local.get $z)))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br_if $ch (i32.lt_u (local.get $c) (local.get $nch))))
      (local.set $y (i32.add (local.get $y) (i32.const 4)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))))
