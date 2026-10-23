// File: packages/acme-example/composeApp/src/commonMain/kotlin/com/acme/example/ui/HarnessComponents.kt
// Created At: 2026-08-24 21:40:00 +07:00
// Created By: AI
// AI Agent: Claude Code
// Model: claude-opus-5
// AI-GENERATED START: the four small pieces every harness screen repeats.
// Pulled out so Home and Module detail stay readable and the tag/mono/uppercase treatments cannot
// drift apart between the two screens the way inline styling always eventually does.
package com.acme.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text

/** The design's `.tag`: a pill of tinted background with short, bold, tight text. */
@Composable
fun TagLabel(
    text: String,
    background: Color,
    contentColor: Color,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    fontSize: Int = 11,
) {
    Text(
        text = text,
        modifier = modifier.pill(background),
        color = contentColor,
        fontSize = fontSize.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        style = if (mono) TextStyle(fontFamily = MonoFamily) else TextStyle.Default,
    )
}

/** Monospace line for anything that names a core symbol, a package or a payload. */
@Composable
fun MonoText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = HarnessColors.neutral600,
    fontSize: Int = 11,
    maxLines: Int = 1,
    lineHeight: Int = 15,
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontSize = fontSize.sp,
        lineHeight = lineHeight.sp,
        fontFamily = MonoFamily,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

/** The uppercase, letter-spaced kicker the design uses above every grouped block. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        color = HarnessColors.neutral600,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.08.em,
    )
}

/** Card surface shared by module rows, test rows and the sidebar-style blocks. */
@Composable
fun Modifier.harnessCard(): Modifier = this.background(HarnessColors.neutral100, HarnessShapes.medium)

/** The dashed outline the design gives to areas the example has not wired yet. */
@Composable
fun Modifier.dashedOutline(color: Color = HarnessColors.neutral300): Modifier = this.drawBehind {
    val stroke = Stroke(
        width = 1.5.dp.toPx(),
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx())),
    )
    val inset = stroke.width / 2f
    drawRoundRect(
        color = color,
        topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
        size = androidx.compose.ui.geometry.Size(size.width - stroke.width, size.height - stroke.width),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(16.dp.toPx()),
        style = stroke,
    )
}

/** Row padding used by every tappable list row, kept in one place for the touch-target rule. */
@Composable
fun Modifier.rowPadding(horizontal: Int = 16, vertical: Int = 12): Modifier =
    this.padding(horizontal = horizontal.dp, vertical = vertical.dp)
// AI-GENERATED END: the four small pieces every harness screen repeats.
