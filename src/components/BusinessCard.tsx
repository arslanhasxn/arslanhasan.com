import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react'
import cardFront from '../assets/card-front.svg'
import './BusinessCard.css'

type CardMode = 'peek' | 'focus'
type FocusPhase = 'scrubbing' | 'opening' | 'ready' | 'closing'

const PEEK_PX = 28
const PEEK_HOVER_EXTRA = 14
const AXIS_LOCK = 10
/** Finger travel (px) that commits a swipe, whatever the card's position */
const SWIPE_COMMIT_PX = 64
/** A flick faster than this (px/s) commits in its direction */
const SWIPE_FLICK = 500

/**
 * Where a released swipe settles. `towardOutPx` / `towardOutV` are positive
 * when the finger moved toward "card out" (up). Flick beats distance, distance
 * beats position; otherwise snap to whichever end the card is nearer.
 */
function settlesOut(towardOutPx: number, towardOutV: number, t: number) {
  if (towardOutV > SWIPE_FLICK) return true
  if (towardOutV < -SWIPE_FLICK) return false
  if (towardOutPx > SWIPE_COMMIT_PX) return true
  if (towardOutPx < -SWIPE_COMMIT_PX) return false
  return t >= 0.5
}

/** Landscape face ratio (matches card-front.svg, 1060×600) */
const FACE_RATIO = 1060 / 600
/** Portrait ratio of the docked peek strip */
const PEEK_RATIO = 600 / 1060

/**
 * Dock flight — slight overshoot past the rest pose, then ease back.
 * Keep bounce low so it reads as smooth, not bouncy.
 */
const dockSpring = {
  type: 'spring' as const,
  visualDuration: 0.5,
  bounce: 0.12,
}

/** Non-overshooting channels (width / backdrop) — clean ease alongside the spring */
const dockFade = {
  type: 'tween' as const,
  duration: 0.4,
  ease: [0.22, 1, 0.36, 1] as const,
}

/** Wait after docking before the first invite */
const INVITE_INITIAL_DELAY_MS = 2000
/** Rest between peek invite nudge pairs */
const INVITE_REST_MS = 3200
const INVITE_LIFT = -12
/** A click right after a swipe is the tail of the gesture, not a tap */
const SWIPE_CLICK_GUARD_MS = 350

/**
 * Card "press" while it is out. `press` runs 0 → 1: the card sinks a touch
 * (scale) and its four edges shade inward, like a thumb pressing it flat.
 * Idle breathes up to IDLE_PEAK; hover / touch eases to 1. Keep it subtle.
 */
const PRESS = {
  idlePeak: 0.4,
  idlePeriod: 5.2,
  /** Scale lost at full press (1 → 0.982) */
  scaleDepth: 0.018,
  held: { type: 'spring' as const, visualDuration: 0.5, bounce: 0 },
  release: { type: 'spring' as const, visualDuration: 0.6, bounce: 0 },
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function clamp01(t: number) {
  return Math.min(1, Math.max(0, t))
}

function viewSize() {
  const vv = window.visualViewport
  return {
    w: vv?.width ?? window.innerWidth,
    h: vv?.height ?? window.innerHeight,
  }
}

function frontWidth() {
  const { w } = viewSize()
  return Math.min(w * 0.86, 36 * 16)
}

/** Visual width of the docked peek strip (portrait slot). */
function peekSlotWidth() {
  const frame = document.querySelector('.app-frame')
  if (!frame) return frontWidth()
  const fr = frame.getBoundingClientRect()
  const padL = parseFloat(getComputedStyle(frame).paddingLeft) || 32
  const padR = parseFloat(getComputedStyle(frame).paddingRight) || 32
  return Math.max(fr.width - padL - padR, 120)
}

type DockPose = {
  x: number
  y: number
  riseW: number
  finalW: number
  rotate: number
  /** Scale at dock so the face matches the peek strip */
  dockScale: number
  /** Width/height ratio for the active face */
  ratio: number
}

export function BusinessCard() {
  const [mode, setMode] = useState<CardMode>('peek')
  const [phase, setPhase] = useState<FocusPhase>('ready')
  const [peekHover, setPeekHover] = useState(false)
  const [hasOpenedOnce, setHasOpenedOnce] = useState(false)
  /** Focused card is hovered (mouse) or touched — deepens the press */
  const [held, setHeld] = useState(false)
  const reduceMotion = useReducedMotion()
  const cardRef = useRef<HTMLButtonElement>(null)
  const peekFootprintRef = useRef<HTMLDivElement>(null)
  const focusFootprintRef = useRef<HTMLDivElement>(null)

  const pointerStart = useRef<{
    x: number
    y: number
    ox: number
    oy: number
    t: number
  } | null>(null)
  const didPull = useRef(false)
  const axisLock = useRef<'h' | 'v' | null>(null)
  const pullKind = useRef<'open' | 'close' | null>(null)
  const dockPose = useRef<DockPose | null>(null)
  const closeScrubStart = useRef<{ x: number; y: number; t: number } | null>(
    null,
  )
  const timers = useRef<number[]>([])
  const pressing = useRef(false)
  const flyAnimRef = useRef<{ stop: () => void } | null>(null)
  /** Mirrors phase for gesture handlers (avoids stale-closure misses on mobile) */
  const phaseRef = useRef<FocusPhase>(phase)
  phaseRef.current = phase

  /** 0 = resting flat, 1 = fully pressed (see PRESS) */
  const press = useMotionValue(0)
  const pressScale = useTransform(press, (p) => 1 - p * PRESS.scaleDepth)
  /** Last time a swipe began or ended — used to swallow the trailing click */
  const lastSwipeAt = useRef(0)
  /** Card progress (0 docked → 1 out) when the current close scrub began */
  const closeScrubT0 = useRef(1)
  /** Where the current open swipe began — owned by the open scrub only */
  const openScrubStart = useRef<{ y: number; t: number } | null>(null)
  /**
   * Last real pointer Y. pointercancel reports clientY 0, so scrubs settle
   * from here instead of trusting the release event's coordinates.
   */
  const lastPointerY = useRef<number | null>(null)

  const flyX = useMotionValue(0)
  const flyY = useMotionValue(0)
  const flyRotate = useMotionValue(0)
  const flyScale = useMotionValue(1)
  const cardW = useMotionValue(frontWidth())
  /** Explicit height — keeps face ratio stable (no Safari aspect-ratio drop) */
  const cardRatio = useMotionValue(FACE_RATIO)
  const cardH = useTransform(
    [cardW, cardRatio],
    ([w, r]) => (w as number) / (r as number),
  )
  const backdropOp = useMotionValue(0)
  /** Peek swipe-up invite bob */
  const peekBobY = useMotionValue(0)

  const focused = mode === 'focus'
  const closing = phase === 'closing'
  const opening = phase === 'opening'
  const scrubbing = phase === 'scrubbing'
  const interactive = focused && phase === 'ready'
  const peekOccluded = focused

  const peekLift = peekHover && !focused ? PEEK_PX + PEEK_HOVER_EXTRA : PEEK_PX

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }

  useEffect(() => {
    return () => {
      clearTimers()
    }
  }, [])

  // Peek: quick pull-pull, then rest — swipe-up prompt (once per page load)
  useEffect(() => {
    if (focused || reduceMotion || peekHover || hasOpenedOnce) {
      peekBobY.set(0)
      return
    }
    let cancelled = false
    let restTimer = 0

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        restTimer = window.setTimeout(resolve, ms)
      })

    const run = async () => {
      // Let the dock settle before prompting
      await sleep(INVITE_INITIAL_DELAY_MS)
      while (!cancelled) {
        // Single keyframed pull-pull — no dead settle between tugs
        await animate(
          peekBobY,
          [0, INVITE_LIFT, INVITE_LIFT * 0.4, INVITE_LIFT, 0],
          {
            duration: 0.84,
            times: [0, 0.24, 0.42, 0.64, 1],
            ease: ['easeOut', 'easeInOut', 'easeOut', 'easeInOut'],
          },
        )
        if (cancelled) break
        await sleep(INVITE_REST_MS)
      }
    }
    void run()
    return () => {
      cancelled = true
      window.clearTimeout(restTimer)
      peekBobY.set(0)
    }
  }, [focused, reduceMotion, peekHover, hasOpenedOnce, peekBobY])

  // Card press: idle breath while out, deeper while hovered / touched, flat while moving.
  useEffect(() => {
    if (!interactive || reduceMotion) {
      const c = animate(press, 0, { duration: 0.3, ease: 'easeOut' })
      return () => c.stop()
    }
    if (held) {
      const c = animate(press, 1, PRESS.held)
      return () => c.stop()
    }
    let cancelled = false
    let ctrl: { stop: () => void } | null = null
    const run = async () => {
      // Ease out of a held press before resuming the breath
      const settle = animate(press, 0, PRESS.release)
      ctrl = settle
      await settle
      if (cancelled) return
      ctrl = animate(press, [0, PRESS.idlePeak, 0], {
        duration: PRESS.idlePeriod,
        ease: 'easeInOut',
        repeat: Infinity,
      })
    }
    void run()
    return () => {
      cancelled = true
      ctrl?.stop()
    }
  }, [interactive, reduceMotion, held, press])

  useEffect(() => {
    if (!interactive) setHeld(false)
  }, [interactive])

  const finishClose = useCallback(() => {
    flyAnimRef.current?.stop()
    flyAnimRef.current = null
    // Snap exact dock pose, then reveal peek (avoids a settle pop on handoff)
    const pose = dockPose.current
    if (pose) {
      flyX.set(pose.x)
      flyY.set(pose.y)
      flyRotate.set(pose.rotate)
      flyScale.set(pose.dockScale)
      cardW.set(pose.riseW)
      cardRatio.set(pose.ratio)
    }
    backdropOp.set(0)
    setPeekHover(false)
    peekBobY.set(0)
    setMode('peek')
    setPhase('ready')
    pullKind.current = null
    dockPose.current = null
    closeScrubStart.current = null
  }, [
    backdropOp,
    flyX,
    flyY,
    flyRotate,
    flyScale,
    cardW,
    cardRatio,
    peekBobY,
  ])

  const measureDockPose = useCallback((): DockPose => {
    const focusW = frontWidth()
    const ratio = FACE_RATIO
    /** Always dock as front-in-portrait-slot — same path whether flipped or not */
    const rotate = 90
    const visualW = focusW / FACE_RATIO
    const peek = peekFootprintRef.current?.getBoundingClientRect()
    if (peek && peek.width > 1 && peek.height > 1) {
      const dockScale = peek.width / Math.max(visualW, 1)
      return {
        x: peek.left + peek.width / 2 - window.innerWidth / 2,
        y: peek.top + peek.height / 2 - window.innerHeight / 2,
        riseW: focusW,
        finalW: focusW,
        rotate,
        dockScale,
        ratio,
      }
    }

    const frame = document.querySelector('.app-frame')
    if (!frame) {
      const { h } = viewSize()
      return {
        x: 0,
        y: h * 0.35,
        riseW: focusW,
        finalW: focusW,
        rotate,
        dockScale: 1,
        ratio,
      }
    }
    const fr = frame.getBoundingClientRect()
    const peekW = peekSlotWidth()
    const peekH = peekW / PEEK_RATIO
    const top = fr.bottom - PEEK_PX
    const dockScale = peekW / Math.max(visualW, 1)
    return {
      x: fr.left + fr.width / 2 - window.innerWidth / 2,
      y: top + peekH / 2 - window.innerHeight / 2,
      riseW: focusW,
      finalW: focusW,
      rotate,
      dockScale,
      ratio,
    }
  }, [])

  const applyPose = useCallback(
    (pose: DockPose, t: number) => {
      flyX.set(lerp(pose.x, 0, t))
      flyY.set(lerp(pose.y, 0, t))
      flyRotate.set(lerp(pose.rotate, 0, t))
      flyScale.set(lerp(pose.dockScale, 1, t))
      cardW.set(lerp(pose.riseW, pose.finalW, t))
      cardRatio.set(pose.ratio)
      backdropOp.set(t)
    },
    [flyX, flyY, flyRotate, flyScale, cardW, cardRatio, backdropOp],
  )

  const animateToPose = useCallback(
    async (pose: DockPose, t: number, onDone?: () => void) => {
      flyAnimRef.current?.stop()
      cardRatio.set(pose.ratio)
      const spring = reduceMotion ? { duration: 0 } : dockSpring
      const fade = reduceMotion ? { duration: 0 } : dockFade
      const endX = lerp(pose.x, 0, t)
      const endY = lerp(pose.y, 0, t)
      const endR = lerp(pose.rotate, 0, t)
      const endS = lerp(pose.dockScale, 1, t)
      const endW = lerp(pose.riseW, pose.finalW, t)
      const ctrls = [
        animate(flyX, endX, spring),
        animate(flyY, endY, spring),
        animate(flyRotate, endR, { ...spring, bounce: 0.08 }),
        animate(flyScale, endS, { ...spring, bounce: 0.09 }),
        animate(cardW, endW, fade),
        animate(backdropOp, t, fade),
      ]
      const handle = { stop: () => ctrls.forEach((c) => c.stop()) }
      flyAnimRef.current = handle
      await Promise.all(ctrls)
      // A swipe grabbed the card mid-flight — that gesture owns it now
      if (flyAnimRef.current !== handle) return
      flyX.set(endX)
      flyY.set(endY)
      flyRotate.set(endR)
      flyScale.set(endS)
      cardW.set(endW)
      backdropOp.set(t)
      flyAnimRef.current = null
      onDone?.()
    },
    [
      flyX,
      flyY,
      flyRotate,
      flyScale,
      cardW,
      cardRatio,
      backdropOp,
      reduceMotion,
    ],
  )

  const dismiss = useCallback(() => {
    if (!focused || closing || scrubbing) return
    clearTimers()
    setPeekHover(false)

    if (reduceMotion) {
      finishClose()
      return
    }

    const pose = measureDockPose()
    dockPose.current = pose
    setPhase('closing')
    void animateToPose(pose, 0, finishClose)
  }, [
    focused,
    closing,
    scrubbing,
    reduceMotion,
    finishClose,
    measureDockPose,
    animateToPose,
  ])

  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, dismiss])

  const updateOpenScrub = useCallback(
    (clientY: number) => {
      const start = openScrubStart.current
      const pose = dockPose.current
      if (!start || !pose) return
      const travel = Math.max(120, Math.abs(pose.y) * 0.85)
      applyPose(pose, clamp01((start.y - clientY) / travel))
    },
    [applyPose],
  )

  const updateCloseScrub = useCallback(
    (clientY: number) => {
      const start = closeScrubStart.current
      const pose = dockPose.current
      if (!start || !pose) return
      const travel = Math.max(120, Math.abs(pose.y) * 0.85)
      applyPose(pose, clamp01(closeScrubT0.current - (clientY - start.y) / travel))
    },
    [applyPose],
  )

  const finishCloseScrub = useCallback(
    (clientY: number) => {
      if (pullKind.current !== 'close') return

      pullKind.current = null
      lastSwipeAt.current = performance.now()
      const start = closeScrubStart.current
      closeScrubStart.current = null
      const pose = dockPose.current

      if (!start || !pose) {
        setPhase('ready')
        phaseRef.current = 'ready'
        return
      }

      const releaseY = lastPointerY.current ?? clientY
      const dt = Math.max(1, performance.now() - start.t)
      const dy = releaseY - start.y
      const velocity = (dy / dt) * 1000
      const t = backdropOp.get()
      const commit = !settlesOut(-dy, -velocity, t)

      if (commit) {
        setPhase('closing')
        phaseRef.current = 'closing'
        void animateToPose(pose, 0, finishClose)
      } else {
        setPhase('opening')
        phaseRef.current = 'opening'
        void animateToPose(pose, 1, () => {
          setPhase('ready')
          phaseRef.current = 'ready'
        })
      }
    },
    [animateToPose, backdropOp, finishClose],
  )

  const beginCloseScrub = useCallback((): boolean => {
    if (pullKind.current === 'open') return false
    if (pullKind.current === 'close') return true

    if (phaseRef.current === 'scrubbing' && !pullKind.current) {
      setPhase('ready')
      phaseRef.current = 'ready'
    }

    if (phaseRef.current === 'scrubbing') return false

    // Grab the card wherever it is — settled or mid-flight
    const flight = flyAnimRef.current
    flyAnimRef.current = null
    flight?.stop()
    closeScrubT0.current = backdropOp.get()

    const pose = measureDockPose()
    dockPose.current = pose
    pullKind.current = 'close'
    didPull.current = true

    const press = pointerStart.current
    closeScrubStart.current = {
      x: press?.x ?? 0,
      y: press?.y ?? 0,
      t: performance.now(),
    }

    setPhase('scrubbing')
    phaseRef.current = 'scrubbing'
    return true
  }, [measureDockPose, backdropOp])

  const finishOpenScrub = useCallback(
    (clientY: number) => {
      if (pullKind.current !== 'open') return
      pullKind.current = null
      lastSwipeAt.current = performance.now()

      const start = openScrubStart.current
      openScrubStart.current = null
      const pose = dockPose.current
      if (!pose) {
        finishClose()
        return
      }
      const dt = Math.max(1, performance.now() - (start?.t ?? performance.now()))
      const releaseY = lastPointerY.current ?? clientY
      const dy = (start?.y ?? releaseY) - releaseY
      const velocity = (dy / dt) * 1000
      const t = backdropOp.get()
      const commit = settlesOut(dy, velocity, t)

      if (commit) {
        setPhase('opening')
        phaseRef.current = 'opening'
        void animateToPose(pose, 1, () => {
          setPhase('ready')
          phaseRef.current = 'ready'
        })
      } else {
        setPhase('closing')
        phaseRef.current = 'closing'
        void animateToPose(pose, 0, finishClose)
      }
    },
    [animateToPose, backdropOp, finishClose],
  )

  const beginOpenScrub = useCallback(
    (clientX: number, clientY: number) => {
      if (mode === 'focus' || pullKind.current === 'open') return
      setPeekHover(false)
      const pose = measureDockPose()
      dockPose.current = pose
      pullKind.current = 'open'
      didPull.current = true
      cardRatio.set(pose.ratio)
      applyPose(pose, 0)
      setHasOpenedOnce(true)
      setPhase('scrubbing')
      phaseRef.current = 'scrubbing'
      setMode('focus')
      openScrubStart.current = { y: clientY, t: performance.now() }
      pointerStart.current = {
        x: clientX,
        y: clientY,
        ox: 0.5,
        oy: 0.5,
        t: performance.now(),
      }
    },
    [mode, measureDockPose, applyPose, cardRatio],
  )

  // Page-wide gesture hygiene: swallow the click that ends a swipe, remember the
  // last pointer position, and keep native drag from stealing the pointer
  useEffect(() => {
    const onClick = (e: Event) => {
      if (performance.now() - lastSwipeAt.current < SWIPE_CLICK_GUARD_MS) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onPoint = (e: PointerEvent) => {
      if (e.type !== 'pointercancel') lastPointerY.current = e.clientY
    }
    // Native drag (selection, link, image) would cancel the pointer mid-swipe
    const onDragStart = (e: Event) => e.preventDefault()
    const opts = { capture: true, passive: true } as const
    window.addEventListener('click', onClick, true)
    window.addEventListener('pointerdown', onPoint, opts)
    window.addEventListener('pointermove', onPoint, opts)
    window.addEventListener('dragstart', onDragStart, true)
    return () => {
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('pointerdown', onPoint, opts)
      window.removeEventListener('pointermove', onPoint, opts)
      window.removeEventListener('dragstart', onDragStart, true)
    }
  }, [])

  // Docked: swipe up anywhere on the page → pull the card out
  useEffect(() => {
    if (focused) return

    let tracking = false
    let startX = 0
    let startY = 0

    const onDown = (e: PointerEvent) => {
      if (pullKind.current) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // The profile photo overlay owns the screen while it is open
      if (document.querySelector('.profile-overlay')) return
      tracking = true
      startX = e.clientX
      startY = e.clientY
    }

    const onMove = (e: PointerEvent) => {
      if (!tracking) return
      if (pullKind.current === 'open') {
        updateOpenScrub(e.clientY)
        e.preventDefault()
        return
      }
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (dy < -AXIS_LOCK && Math.abs(dy) > Math.abs(dx)) {
        tracking = false
        lastSwipeAt.current = performance.now()
        beginOpenScrub(startX, startY)
        updateOpenScrub(e.clientY)
        e.preventDefault()
      }
    }

    const onUp = (e: PointerEvent) => {
      tracking = false
      // Finish even if React hasn't committed `scrubbing` yet
      if (pullKind.current === 'open') {
        finishOpenScrub(e.clientY)
        pointerStart.current = null
        pressing.current = false
        axisLock.current = null
      }
    }

    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [
    focused,
    reduceMotion,
    beginOpenScrub,
    updateOpenScrub,
    finishOpenScrub,
  ])

  // Focused: swipe down anywhere on the page (card included) → dock
  useEffect(() => {
    if (!focused) return

    let tracking = false
    let startX = 0
    let startY = 0

    const onDown = (e: PointerEvent) => {
      if (pullKind.current) return
      if (phaseRef.current === 'scrubbing') return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      tracking = true
      startX = e.clientX
      startY = e.clientY
    }

    const onMove = (e: PointerEvent) => {
      if (pullKind.current === 'close') {
        updateCloseScrub(e.clientY)
        e.preventDefault()
        return
      }
      if (!tracking) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const vertical = Math.abs(dy) > AXIS_LOCK && Math.abs(dy) > Math.abs(dx) * 0.85
      // Down always docks; up only matters while the card is mid-flight
      if (vertical && (dy > 0 || phaseRef.current !== 'ready')) {
        tracking = false
        lastSwipeAt.current = performance.now()
        pointerStart.current = {
          x: startX,
          y: startY,
          ox: 0.5,
          oy: 0.5,
          t: performance.now(),
        }
        pressing.current = true
        didPull.current = true
        axisLock.current = 'v'
        beginCloseScrub()
        updateCloseScrub(e.clientY)
        e.preventDefault()
      }
    }

    const onUp = (e: PointerEvent) => {
      tracking = false
      if (pullKind.current === 'close') {
        finishCloseScrub(e.clientY)
        pressing.current = false
        pointerStart.current = null
        axisLock.current = null
      }
    }

    const opts = { capture: true } as const
    window.addEventListener('pointerdown', onDown, { ...opts, passive: true })
    window.addEventListener('pointermove', onMove, { ...opts, passive: false })
    window.addEventListener('pointerup', onUp, opts)
    window.addEventListener('pointercancel', onUp, opts)
    return () => {
      window.removeEventListener('pointerdown', onDown, opts)
      window.removeEventListener('pointermove', onMove, opts)
      window.removeEventListener('pointerup', onUp, opts)
      window.removeEventListener('pointercancel', onUp, opts)
    }
  }, [
    focused,
    reduceMotion,
    beginCloseScrub,
    updateCloseScrub,
    finishCloseScrub,
  ])

  // Scrub move/up while pulling
  useEffect(() => {
    if (!scrubbing) return

    const onMove = (e: PointerEvent) => {
      if (pullKind.current === 'open') updateOpenScrub(e.clientY)
      else if (pullKind.current === 'close') updateCloseScrub(e.clientY)
    }
    const onUp = (e: PointerEvent) => {
      if (pullKind.current === 'open') finishOpenScrub(e.clientY)
      else if (pullKind.current === 'close') finishCloseScrub(e.clientY)
      pointerStart.current = null
      pressing.current = false
      axisLock.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [
    scrubbing,
    updateOpenScrub,
    updateCloseScrub,
    finishOpenScrub,
    finishCloseScrub,
  ])

  const openFromPeek = useCallback(() => {
    clearTimers()
    setPeekHover(false)
    const pose = measureDockPose()
    dockPose.current = pose
    cardRatio.set(pose.ratio)
    applyPose(pose, 0)
    setHasOpenedOnce(true)
    setPhase('opening')
    phaseRef.current = 'opening'
    setMode('focus')
    void animateToPose(pose, 1, () => {
      setPhase('ready')
      phaseRef.current = 'ready'
    })
  }, [measureDockPose, applyPose, cardRatio, animateToPose])

  const onPeekPointerDown = (e: ReactPointerEvent) => {
    if (focused) return
    pointerStart.current = {
      x: e.clientX,
      y: e.clientY,
      ox: 0.5,
      oy: 0.5,
      t: performance.now(),
    }
    pressing.current = true
    didPull.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPeekPointerMove = (e: ReactPointerEvent) => {
    if (!pressing.current || focused || !pointerStart.current) return
    if (pullKind.current === 'open') {
      updateOpenScrub(e.clientY)
      return
    }
    const dx = e.clientX - pointerStart.current.x
    const dy = e.clientY - pointerStart.current.y
    if (dy < -AXIS_LOCK && Math.abs(dy) > Math.abs(dx)) {
      beginOpenScrub(pointerStart.current.x, pointerStart.current.y)
      updateOpenScrub(e.clientY)
    }
  }

  const onPeekPointerUp = (e: ReactPointerEvent) => {
    pressing.current = false
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ok */
    }

    // Finish pull-open here so a fast flick isn't lost waiting on React state
    if (pullKind.current === 'open') {
      finishOpenScrub(e.clientY)
      pointerStart.current = null
      axisLock.current = null
      return
    }

    if (
      !focused &&
      !didPull.current &&
      pointerStart.current &&
      Math.hypot(
        e.clientX - pointerStart.current.x,
        e.clientY - pointerStart.current.y,
      ) < AXIS_LOCK
    ) {
      openFromPeek()
    }
    pointerStart.current = null
  }

  // Focused card: tap → dock, drag down → scrub back into the dock. No rotation.
  const onCardPointerDown = (e: ReactPointerEvent) => {
    if (!interactive) return
    pointerStart.current = {
      x: e.clientX,
      y: e.clientY,
      ox: 0.5,
      oy: 0.5,
      t: performance.now(),
    }
    pressing.current = true
    didPull.current = false
    // Finger on the card itself (not the grab padding) → press it in
    if (focusFootprintRef.current?.contains(e.target as Node)) setHeld(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onCardPointerMove = (e: ReactPointerEvent) => {
    if (!pressing.current || !pointerStart.current) return
    if (pullKind.current === 'close') {
      updateCloseScrub(e.clientY)
      return
    }
    const dx = e.clientX - pointerStart.current.x
    const dy = e.clientY - pointerStart.current.y
    if (dy > AXIS_LOCK && dy > Math.abs(dx) * 0.85) {
      didPull.current = true
      if (beginCloseScrub()) updateCloseScrub(e.clientY)
    } else if (Math.hypot(dx, dy) > AXIS_LOCK) {
      // Sideways / upward drag: not a tap, not a dock — ignore
      didPull.current = true
    }
  }

  const onCardPointerUp = (e: ReactPointerEvent) => {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
    const wasPress = pressing.current
    pressing.current = false
    // Touch has no hover — let go releases the press. Mouse keeps it while hovering.
    if (e.pointerType !== 'mouse') setHeld(false)
    if (pullKind.current === 'close') {
      finishCloseScrub(e.clientY)
    } else if (wasPress && !didPull.current) {
      dismiss()
    }
    pointerStart.current = null
    axisLock.current = null
  }

  /** Keyboard activation (Enter / Space) — pointer taps go through onCardPointerUp */
  const onCardClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (e.detail === 0 && interactive) dismiss()
  }

  const flying = opening || closing || scrubbing

  return (
    <>
      {focused && (
        <motion.button
          type="button"
          className="card-backdrop"
          aria-label="Dismiss business card"
          style={{ opacity: backdropOp }}
          transition={{ duration: 0 }}
          onPointerDown={(e) => {
            if (phaseRef.current !== 'ready') return
            if (pullKind.current) return
            const card = focusFootprintRef.current?.getBoundingClientRect()
            const aboveCard = !!card && e.clientY < card.top
            const belowCard = !!card && e.clientY > card.bottom
            pointerStart.current = {
              x: e.clientX,
              y: e.clientY,
              ox: 0.5,
              oy: aboveCard ? -0.35 : belowCard ? 1.35 : 0.5,
              t: performance.now(),
            }
            pressing.current = true
            didPull.current = false
            axisLock.current = null
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!pressing.current || !pointerStart.current) return
            if (pullKind.current === 'close') {
              updateCloseScrub(e.clientY)
              return
            }
            if (phaseRef.current !== 'ready') return
            // Pull-to-dock when the gesture began in empty space above or below the card
            const offCard =
              pointerStart.current.oy < 0 || pointerStart.current.oy > 1
            if (!offCard) return
            const dx = e.clientX - pointerStart.current.x
            const dy = e.clientY - pointerStart.current.y
            if (dy > AXIS_LOCK && Math.abs(dy) > Math.abs(dx) * 0.85) {
              axisLock.current = 'v'
              didPull.current = true
              beginCloseScrub()
              updateCloseScrub(e.clientY)
            }
          }}
          onPointerUp={(e) => {
            try {
              ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
            } catch {
              /* ok */
            }
            if (pullKind.current === 'close') {
              finishCloseScrub(e.clientY)
              pressing.current = false
              pointerStart.current = null
              axisLock.current = null
              return
            }
            const start = pointerStart.current
            pressing.current = false
            pointerStart.current = null
            axisLock.current = null
            // Tap on backdrop (no pull) → dismiss
            if (
              start &&
              !didPull.current &&
              Math.hypot(e.clientX - start.x, e.clientY - start.y) < AXIS_LOCK
            ) {
              dismiss()
            }
          }}
          onPointerCancel={(e) => {
            try {
              ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
            } catch {
              /* ok */
            }
            if (pullKind.current === 'close') {
              finishCloseScrub(e.clientY)
            }
            pressing.current = false
            pointerStart.current = null
            axisLock.current = null
          }}
        />
      )}

      <div className="card-label-wrap">
        <p className="card-label">(VERY SERIOUS) BUSINESS CARD</p>
      </div>

      <div
        className={`card-slot is-peek${peekOccluded ? ' is-occluded' : ''}`}
        style={{
          transform: `translateY(calc(100% - ${peekLift}px))`,
        }}
        onMouseEnter={() => {
          if (!focused) setPeekHover(true)
        }}
        onMouseLeave={() => setPeekHover(false)}
      >
        <button
          type="button"
          className="card-hit"
          aria-label="Open business card"
          aria-expanded={focused}
          tabIndex={focused ? -1 : 0}
          onPointerDown={onPeekPointerDown}
          onPointerMove={onPeekPointerMove}
          onPointerUp={onPeekPointerUp}
          onPointerCancel={onPeekPointerUp}
        >
          <motion.div
            className="card-tilt"
            style={{ width: '100%', y: peekBobY }}
          >
            <div
              ref={peekFootprintRef}
              className="card-footprint card-footprint--peek"
            >
              <div className="card-stage">
                <div className="card-flip">
                  <div
                    className="card-face card-face--front card-face--docked grain-gradient grain-gradient--card-front"
                  >
                    <img src={cardFront} alt="" draggable={false} />
                    {!reduceMotion && (
                      <span className="card-wave" aria-hidden="true" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </button>
      </div>

      {focused && (
        <div className="card-slot is-focus">
          <motion.div
            className="card-fly"
            style={{
              x: flyX,
              y: flyY,
              rotate: flyRotate,
              scale: flyScale,
            }}
          >
            <motion.button
              ref={cardRef}
              type="button"
              className="card-hit"
              aria-label="Put business card away"
              aria-expanded
              onClick={onCardClick}
              onPointerDown={onCardPointerDown}
              onPointerMove={onCardPointerMove}
              onPointerUp={onCardPointerUp}
              onPointerCancel={onCardPointerUp}
            >
              <motion.div className="card-tilt" style={{ scale: pressScale }}>
                <motion.div
                  ref={focusFootprintRef}
                  className={`card-footprint${flying ? ' is-flying' : ''}`}
                  style={{
                    width: cardW,
                    height: cardH,
                  }}
                  // Real hover only: the card flying in under a resting cursor
                  // fires pointerenter without the user doing anything
                  onPointerMove={(e) => {
                    if (e.pointerType === 'mouse' && interactive && !held) {
                      setHeld(true)
                    }
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === 'mouse') setHeld(false)
                  }}
                >
                  <div className="card-stage is-live">
                    <div className="card-face card-face--front grain-gradient grain-gradient--card-front">
                      <img src={cardFront} alt="" draggable={false} />
                      {!reduceMotion && (
                        <span
                          className="card-wave card-wave--soft"
                          aria-hidden="true"
                        />
                      )}
                      <motion.span
                        className="card-press-edge"
                        style={{ opacity: press }}
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            </motion.button>
          </motion.div>
        </div>
      )}
    </>
  )
}
