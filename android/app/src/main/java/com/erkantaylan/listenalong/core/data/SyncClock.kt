package com.erkantaylan.listenalong.core.data

/**
 * The clock playlist sync judges time by (the 24-hour wait before a big
 * shrink is accepted, the day a missing file is skipped). It is the wall
 * clock; debug builds can move it forward for this process only
 * (MainActivity's `clock_offset_ms` extra) to try those rules on an
 * emulator. Release builds never set [offsetMs]; the rules' values are
 * never shortened.
 */
object SyncClock {
    @Volatile var offsetMs: Long = 0

    fun now(): Long = System.currentTimeMillis() + offsetMs
}
