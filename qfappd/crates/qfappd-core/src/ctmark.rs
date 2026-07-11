//! ct-mark bit layout and codec.
//!
//! The conntrack mark is shared with other QuartzFire subsystems, so every
//! write — from nftables rules and from qfappd via ctnetlink — is masked to
//! the fields defined here and never disturbs foreign bits.
//!
//! Default layout (configurable via `[mark]` in qfappd.toml; the nft template
//! is rendered from the same `Layout`, so kernel rules and userspace can
//! never disagree):
//!
//! ```text
//! bit  31       CLASSIFIED   flow has a final app-control verdict
//! bit  30       BLOCK        verdict was block (drop rule matches this)
//! bits 29–19    APP_ID       nDPI protocol id (11 bits, 0 = unknown)
//! bits 18–16    ACTION_ID    named action governing this flow
//!                            (0 = app control not enabled for the flow)
//! bits 15–0     untouched    reserved for other QuartzFire subsystems
//! ```

use serde::Serialize;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LayoutError {
    #[error("bit position {0} out of range (0..=31)")]
    BitOutOfRange(u8),
    #[error("field {0} exceeds bit 31 (shift {1} + bits {2})")]
    FieldOverflow(&'static str, u8, u8),
    #[error("field {0} must be at least 1 bit wide")]
    EmptyField(&'static str),
    #[error("fields overlap (combined mask covered {expected} bits, got {actual})")]
    Overlap { expected: u32, actual: u32 },
}

/// The single source of truth for the mark encoding. Immutable once built.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Layout {
    pub classified_bit: u8,
    pub block_bit: u8,
    pub app_shift: u8,
    pub app_bits: u8,
    pub action_shift: u8,
    pub action_bits: u8,
}

/// A decoded mark, as qfappd reads it off a flow's conntrack entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkState {
    pub classified: bool,
    pub block: bool,
    pub app_id: u16,
    pub action_id: u8,
}

impl Layout {
    pub fn new(
        classified_bit: u8,
        block_bit: u8,
        app_shift: u8,
        app_bits: u8,
        action_shift: u8,
        action_bits: u8,
    ) -> Result<Self, LayoutError> {
        for bit in [classified_bit, block_bit] {
            if bit > 31 {
                return Err(LayoutError::BitOutOfRange(bit));
            }
        }
        for (name, shift, bits) in [("app_id", app_shift, app_bits), ("action_id", action_shift, action_bits)] {
            if bits == 0 {
                return Err(LayoutError::EmptyField(name));
            }
            if u32::from(shift) + u32::from(bits) > 32 {
                return Err(LayoutError::FieldOverflow(name, shift, bits));
            }
        }
        let layout = Self { classified_bit, block_bit, app_shift, app_bits, action_shift, action_bits };
        // Fields must not overlap: the union of the masks must have exactly
        // as many set bits as the fields claim.
        let expected = 2 + u32::from(app_bits) + u32::from(action_bits);
        let actual = layout.qf_mask().count_ones();
        if expected != actual {
            return Err(LayoutError::Overlap { expected, actual });
        }
        Ok(layout)
    }

    pub fn classified_mask(&self) -> u32 {
        1 << self.classified_bit
    }

    pub fn block_mask(&self) -> u32 {
        1 << self.block_bit
    }

    pub fn app_mask(&self) -> u32 {
        (((1u64 << self.app_bits) - 1) as u32) << self.app_shift
    }

    pub fn action_mask(&self) -> u32 {
        (((1u64 << self.action_bits) - 1) as u32) << self.action_shift
    }

    /// Every bit qfappd may touch. The complement is reserved for other
    /// QuartzFire subsystems and is never written.
    pub fn qf_mask(&self) -> u32 {
        self.classified_mask() | self.block_mask() | self.app_mask() | self.action_mask()
    }

    pub fn max_app_id(&self) -> u16 {
        ((1u32 << self.app_bits) - 1) as u16
    }

    /// Highest usable ACTION_ID (0 means "no app control"), i.e. the
    /// maximum number of concurrently bound named actions.
    pub fn max_action_id(&self) -> u8 {
        ((1u32 << self.action_bits) - 1) as u8
    }

    /// Encode a classification verdict as a masked write. The mask covers
    /// classified + block + app bits but NOT the action bits: those were
    /// written by the binding's nftables rule and must survive the verdict.
    /// App IDs above the field width are recorded as 0 (unknown) rather than
    /// truncated to some other app's id.
    pub fn encode_verdict(&self, app_id: u16, block: bool) -> MaskedWrite {
        let app = if app_id > self.max_app_id() { 0 } else { u32::from(app_id) };
        let mut value = self.classified_mask() | (app << self.app_shift);
        if block {
            value |= self.block_mask();
        }
        MaskedWrite {
            value,
            mask: self.classified_mask() | self.block_mask() | self.app_mask(),
        }
    }

    /// Encode the ACTION_ID write performed by a binding's nftables rule.
    pub fn encode_action(&self, action_id: u8) -> MaskedWrite {
        debug_assert!(action_id <= self.max_action_id());
        MaskedWrite {
            value: u32::from(action_id) << self.action_shift,
            mask: self.action_mask(),
        }
    }

    pub fn decode(&self, mark: u32) -> MarkState {
        MarkState {
            classified: mark & self.classified_mask() != 0,
            block: mark & self.block_mask() != 0,
            app_id: ((mark & self.app_mask()) >> self.app_shift) as u16,
            action_id: ((mark & self.action_mask()) >> self.action_shift) as u8,
        }
    }
}

impl Default for Layout {
    fn default() -> Self {
        Self::new(31, 30, 19, 11, 16, 3).expect("default layout is valid")
    }
}

/// A masked mark update: `mark = (mark & !mask) | value`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaskedWrite {
    pub value: u32,
    pub mask: u32,
}

impl MaskedWrite {
    pub fn apply(&self, current: u32) -> u32 {
        (current & !self.mask) | self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_layout_masks() {
        let l = Layout::default();
        assert_eq!(l.classified_mask(), 0x8000_0000);
        assert_eq!(l.block_mask(), 0x4000_0000);
        assert_eq!(l.app_mask(), 0x3FF8_0000);
        assert_eq!(l.action_mask(), 0x0007_0000);
        assert_eq!(l.qf_mask(), 0xFFFF_0000);
        assert_eq!(l.max_app_id(), 2047);
        assert_eq!(l.max_action_id(), 7);
    }

    #[test]
    fn verdict_roundtrip() {
        let l = Layout::default();
        for (app, block) in [(0u16, false), (1, true), (244, false), (2047, true)] {
            let w = l.encode_verdict(app, block);
            let state = l.decode(w.apply(0));
            assert!(state.classified);
            assert_eq!(state.block, block);
            assert_eq!(state.app_id, app);
        }
    }

    #[test]
    fn low_bits_never_disturbed() {
        let l = Layout::default();
        let foreign = 0x0000_BEEF; // another QuartzFire subsystem's bits
        let w = l.encode_verdict(500, true);
        let mark = w.apply(foreign);
        assert_eq!(mark & 0x0000_FFFF, foreign);
        // and the action write preserves them too
        let mark = l.encode_action(5).apply(mark);
        assert_eq!(mark & 0x0000_FFFF, foreign);
    }

    #[test]
    fn verdict_preserves_action_bits() {
        let l = Layout::default();
        let with_action = l.encode_action(3).apply(0);
        let mark = l.encode_verdict(42, false).apply(with_action);
        let state = l.decode(mark);
        assert_eq!(state.action_id, 3);
        assert_eq!(state.app_id, 42);
        assert!(state.classified);
        assert!(!state.block);
    }

    #[test]
    fn oversized_app_id_becomes_unknown() {
        let l = Layout::default();
        let mark = l.encode_verdict(4000, false).apply(0);
        assert_eq!(l.decode(mark).app_id, 0);
    }

    #[test]
    fn overlapping_layout_rejected() {
        // block bit inside the app field
        assert_eq!(
            Layout::new(31, 25, 19, 11, 16, 3).unwrap_err(),
            LayoutError::Overlap { expected: 16, actual: 15 }
        );
    }

    #[test]
    fn overflowing_field_rejected() {
        assert!(matches!(
            Layout::new(31, 30, 25, 11, 16, 3),
            Err(LayoutError::FieldOverflow("app_id", 25, 11))
        ));
    }

    #[test]
    fn custom_layout_roundtrip() {
        // 4 action bits at the cost of one app bit, as design.md offers.
        let l = Layout::new(31, 30, 20, 10, 16, 4).unwrap();
        assert_eq!(l.max_action_id(), 15);
        assert_eq!(l.max_app_id(), 1023);
        assert_eq!(l.qf_mask(), 0xFFFF_0000);
        let mark = l.encode_action(15).apply(0x1234);
        let mark = l.encode_verdict(1023, true).apply(mark);
        let s = l.decode(mark);
        assert_eq!((s.action_id, s.app_id, s.block, s.classified), (15, 1023, true, true));
        assert_eq!(mark & 0xFFFF, 0x1234);
    }
}
