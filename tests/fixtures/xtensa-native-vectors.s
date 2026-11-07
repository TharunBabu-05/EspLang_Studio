# Handwritten ISA vectors. GNU as --no-transform used only as an independent oracle.
value: .word 0x12345678
start:
  l32r a2, value
  l32r a3, value
  l32r a4, value
  l32r a5, value
  beq a2, a3, start
  bne a2, a3, start
  blt a2, a3, start
  bge a2, a3, start
  bltu a2, a3, start
  bgeu a2, a3, start
  beqz a2, start
  bnez a2, start
  j start
  movi a2, 1
  movi a6, 500
  movi a15, -2048
  movi a2, -1
  addi a6, a6, -1
  l32i a2, a3, 0
  s32i a2, a3, 0
  l32i a15, a0, 1020
  add a2, a2, a3
  sub a8, a8, a7
  and a2, a2, a4
  or a3, a2, a2
  xor a2, a2, a3
  mull a2, a2, a3
  rsil a2, 15
  rsr a7, ccount
  wsr a2, ps
  memw
  isync
again:
  j again
