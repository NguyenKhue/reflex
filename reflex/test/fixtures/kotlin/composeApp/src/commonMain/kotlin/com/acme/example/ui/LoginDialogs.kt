// File: packages/acme-example/composeApp/src/commonMain/kotlin/com/acme/example/ui/LoginDialogs.kt
// Created At: 2026-08-25 16:40:00 +07:00
// Created By: AI
// AI Agent: Claude Code
// Model: claude-opus-5
// AI-GENERATED START: the login as Acme presents it — one popup per step.
// The app does not show a form; it shows a sequence of modals, and each one answers before the
// next appears. Five here: the phone number (`checkUser`), the two screens the core's auth-switcher
// asks the host for on a new device — the method list and the OTP entry — the password (`login`),
// and the resulting session token.
package com.acme.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.acme.example.harness.LoginAction
import com.acme.example.harness.LoginDialog
import com.acme.example.harness.LoginFlowState
import com.acme.example.harness.LoginStep
// AI-GENERATED START: popup phương thức và màn OTP của auth-switcher
import com.acme.example.harness.LoginAuthOption
import com.acme.example.harness.REQUIRED_OTP_CODE
// AI-GENERATED END: popup phương thức và màn OTP của auth-switcher

/** Renders whichever popup the flow is currently on. NONE draws nothing. */
@Composable
fun LoginDialogHost(
    state: LoginFlowState,
    onChange: (LoginFlowState) -> Unit,
    onRun: (LoginAction) -> Unit,
) {
    if (state.dialog == LoginDialog.NONE) return
    val dismiss = { if (!state.isBusy) onChange(state.showing(LoginDialog.NONE)) else Unit }
    Dialog(onDismissRequest = dismiss) {
        AcmePopup {
            when (state.dialog) {
                // AI-GENERATED START: popup phương thức và màn OTP của auth-switcher
                LoginDialog.PHONE -> PhonePopup(state, onChange, onRun, dismiss)
                LoginDialog.METHOD -> MethodPopup(state, onChange, onRun, dismiss)
                LoginDialog.OTP -> OtpPopup(state, onChange, onRun, dismiss)
                LoginDialog.PIN -> PinPopup(state, onChange, onRun, dismiss)
                // AI-GENERATED END: popup phương thức và màn OTP của auth-switcher
                LoginDialog.RESULT -> ResultPopup(state, onChange, onRun)
                LoginDialog.NONE -> Unit
            }
        }
    }
}

@Composable
private fun AcmePopup(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(HarnessColors.neutral100, HarnessShapes.large)
            .padding(horizontal = 20.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        content()
    }
}

@Composable
private fun PopupHeader(step: LoginStep, title: String, desc: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MonoText(
            // AI-GENERATED START: số bước lấy từ LoginStep, không hard-code
            text = "Bước ${step.ordinal + 1}/${LoginStep.entries.size} · ${step.cmd}",
            // AI-GENERATED END: số bước lấy từ LoginStep, không hard-code
            fontSize = 10,
            color = HarnessColors.accent700,
        )
        Text(text = title, fontSize = 19.sp, fontWeight = FontWeight.Bold, color = HarnessColors.text)
        if (desc.isNotEmpty()) {
            Text(
                text = desc,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                color = HarnessColors.neutral700,
            )
        }
    }
}

// AI-GENERATED START: popup phương thức và màn OTP của auth-switcher
@Composable
private fun PhonePopup(
    state: LoginFlowState,
    onChange: (LoginFlowState) -> Unit,
    onRun: (LoginAction) -> Unit,
    onDismiss: () -> Unit,
) {
    PopupHeader(
        LoginStep.PHONE,
        "Đăng nhập Acme",
        "Nhập số điện thoại đã đăng ký ví. Thiết bị mới sẽ được hỏi phương thức xác thực.",
    )
    PopupField(
        value = state.phone,
        placeholder = "09xxxxxxxx",
        keyboard = KeyboardType.Phone,
        enabled = !state.isBusy,
        onValueChange = { onChange(state.copy(phone = it)) },
    )
    Failure(state, LoginStep.PHONE)
    PopupActions(
        state = state,
        primaryLabel = "Tiếp tục",
        onPrimary = { onRun(LoginAction.CHECK_PHONE) },
        onDismiss = onDismiss,
    )
}

@Composable
private fun MethodPopup(
    state: LoginFlowState,
    onChange: (LoginFlowState) -> Unit,
    onRun: (LoginAction) -> Unit,
    onDismiss: () -> Unit,
) {
    val session = state.session
    PopupHeader(
        step = LoginStep.OTP,
        title = session.popupTitle.ifEmpty { "Chọn phương thức xác thực" },
        desc = session.popupDesc.ifEmpty { "Danh sách do auth-switcher của core đưa sang." },
    )
    if (session.options.isEmpty()) {
        MonoText(text = "backend không trả phương thức nào", fontSize = 11, maxLines = 2)
    }
    // Only the OTP row finishes here: the other methods open the app's eKYC / face screens, which the
    // example has none of. "Huỷ" only closes the popup — the switcher keeps waiting, the OTP row reopens
    // it, and running step 1 again makes the driver back out of the old challenge.
    MonoText(
        text = "Example chỉ đi được phương thức OTP ($REQUIRED_OTP_CODE) — các cách khác mở màn " +
            "eKYC/khuôn mặt của app.",
        fontSize = 10,
        maxLines = 3,
    )
    Column(
        modifier = Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        session.options.forEach { option ->
            MethodRow(
                option = option,
                isSelected = option.key == session.chosen?.key,
                enabled = option.isEnabled && !state.isBusy,
                onClick = { onChange(state.choosing(option)) },
            )
        }
    }
    Failure(state, LoginStep.OTP)
    PopupActions(
        state = state,
        primaryLabel = "Tiếp tục",
        primaryEnabled = session.chosen != null,
        onPrimary = { onRun(LoginAction.SEND_OTP) },
        onDismiss = onDismiss,
    )
}

@Composable
private fun MethodRow(
    option: LoginAuthOption,
    isSelected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = TouchTarget)
            .background(
                color = if (isSelected) HarnessColors.accent100 else HarnessColors.neutral200,
                shape = HarnessShapes.input,
            )
            .border(
                width = 1.5.dp,
                color = if (isSelected) HarnessColors.accent600 else HarnessColors.divider,
                shape = HarnessShapes.input,
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(20.dp)
                .background(
                    color = if (isSelected) HarnessColors.accent else HarnessColors.neutral100,
                    shape = CircleShape,
                )
                .border(1.5.dp, HarnessColors.neutral400, CircleShape),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = option.text,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (enabled) HarnessColors.text else HarnessColors.neutral500,
            )
            MonoText(
                text = "${option.code}${if (option.otpType.isEmpty()) "" else " · ${option.otpType}"}" +
                    if (option.subText.isEmpty()) "" else " · ${option.subText}",
                fontSize = 10,
                maxLines = 2,
            )
        }
        if (!option.isEnabled) {
            TagLabel(
                text = "DISABLE",
                background = HarnessColors.neutral300,
                contentColor = HarnessColors.neutral700,
                fontSize = 9,
            )
        }
    }
}
// AI-GENERATED END: popup phương thức và màn OTP của auth-switcher

// AI-GENERATED START: màn OTP của auth-switcher
@Composable
private fun OtpPopup(
    state: LoginFlowState,
    onChange: (LoginFlowState) -> Unit,
    onRun: (LoginAction) -> Unit,
    onDismiss: () -> Unit,
) {
    val channel = otpChannelLabel(state.session.otpType)
    PopupHeader(
        step = LoginStep.OTP,
        title = "Nhập mã xác thực",
        desc = "Mã đã gửi qua $channel tới ${state.phone}. Nhập mã bạn nhận được trên máy.",
    )
    PopupField(
        value = state.otp,
        placeholder = "• • • • • •",
        keyboard = KeyboardType.NumberPassword,
        enabled = !state.isBusy,
        centered = true,
        onValueChange = { onChange(state.copy(otp = it)) },
    )
    Failure(state, LoginStep.OTP)
    // "Gửi lại" spends the tokenOTP genToken gave the OTP screen again (`initializeLoginOtp`);
    // the switcher keeps waiting.
    Text(
        text = "Chưa nhận được mã? ${LoginAction.RESEND_OTP.label}",
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !state.isBusy) { onRun(LoginAction.RESEND_OTP) }
            .padding(vertical = 6.dp),
        color = HarnessColors.accent600,
        fontSize = 11.5.sp,
        textAlign = TextAlign.Center,
    )
    PopupActions(
        state = state,
        primaryLabel = "Xác nhận",
        onPrimary = { onRun(LoginAction.VERIFY_OTP) },
        onDismiss = onDismiss,
    )
}
// AI-GENERATED END: màn OTP của auth-switcher

// AI-GENERATED START: mật khẩu sau khi checkUser qua
@Composable
private fun PinPopup(
    state: LoginFlowState,
    onChange: (LoginFlowState) -> Unit,
    onRun: (LoginAction) -> Unit,
    onDismiss: () -> Unit,
) {
    PopupHeader(LoginStep.PIN, "Nhập mật khẩu", "checkUser đã qua. Nhập mật khẩu ví Acme để đăng nhập.")
    PopupField(
        value = state.pin,
        placeholder = "• • • • • •",
        keyboard = KeyboardType.NumberPassword,
        enabled = !state.isBusy,
        masked = true,
        centered = true,
        onValueChange = { onChange(state.copy(pin = it)) },
    )
    Failure(state, LoginStep.PIN)
    PopupActions(
        state = state,
        primaryLabel = "Đăng nhập",
        onPrimary = { onRun(LoginAction.LOGIN) },
        onDismiss = onDismiss,
    )
}
// AI-GENERATED END: mật khẩu sau khi checkUser qua

@Composable
private fun ResultPopup(
    state: LoginFlowState,
    onChange: (LoginFlowState) -> Unit,
    onRun: (LoginAction) -> Unit,
) {
    // AI-GENERATED START: tóm tắt lấy từ bước đăng nhập
    PopupHeader(LoginStep.TOKEN, "Đăng nhập thành công", state.outcomeOf(LoginStep.PIN)?.summary.orEmpty())
    // AI-GENERATED END: tóm tắt lấy từ bước đăng nhập
    TagLabel(
        text = "status: success",
        background = HarnessColors.accent2_200,
        contentColor = HarnessColors.accent2_800,
        mono = true,
        fontSize = 12,
    )
    state.outcomeOf(LoginStep.TOKEN)?.let { outcome ->
        MonoText(
            text = outcome.detail,
            modifier = Modifier
                .fillMaxWidth()
                .background(HarnessColors.neutral900, HarnessShapes.small)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            color = HarnessColors.neutral200,
            fontSize = 10,
            maxLines = 12,
            lineHeight = 15,
        )
    }
    PopupActions(
        state = state,
        primaryLabel = "Đọc token",
        onPrimary = { onRun(LoginAction.READ_TOKEN) },
        onDismiss = { onChange(state.showing(LoginDialog.NONE)) },
        dismissLabel = "Đóng",
    )
}

/** Shows the last failure for [step] inside the popup, so the reason never leaves the screen. */
@Composable
private fun Failure(state: LoginFlowState, step: LoginStep) {
    val outcome = state.outcomeOf(step) ?: return
    if (outcome.isSuccess) return
    MonoText(
        text = "✕ ${outcome.summary}",
        modifier = Modifier
            .fillMaxWidth()
            .background(HarnessColors.accent200, HarnessShapes.small)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        color = HarnessColors.accent800,
        fontSize = 10,
        maxLines = 6,
        lineHeight = 15,
    )
}

@Composable
private fun PopupField(
    value: String,
    placeholder: String,
    keyboard: KeyboardType,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    masked: Boolean = false,
    centered: Boolean = false,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .background(HarnessColors.bg, HarnessShapes.input)
            .border(1.5.dp, HarnessColors.divider, HarnessShapes.input)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        contentAlignment = if (centered) Alignment.Center else Alignment.CenterStart,
    ) {
        if (value.isEmpty()) {
            MonoText(text = placeholder, fontSize = 15, color = HarnessColors.neutral400)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = keyboard),
            visualTransformation = if (masked) {
                PasswordVisualTransformation()
            } else {
                VisualTransformation.None
            },
            textStyle = TextStyle(
                fontFamily = MonoFamily,
                fontSize = 15.sp,
                color = HarnessColors.text,
                textAlign = if (centered) TextAlign.Center else TextAlign.Start,
            ),
            cursorBrush = SolidColor(HarnessColors.accent),
        )
    }
}

@Composable
private fun PopupActions(
    state: LoginFlowState,
    primaryLabel: String,
    onPrimary: () -> Unit,
    onDismiss: () -> Unit,
    primaryEnabled: Boolean = true,
    dismissLabel: String = "Huỷ",
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 48.dp)
                .border(1.5.dp, HarnessColors.divider, HarnessShapes.pill)
                .clickable(enabled = !state.isBusy, onClick = onDismiss)
                .padding(vertical = 13.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = dismissLabel,
                color = HarnessColors.neutral700,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Box(
            modifier = Modifier
                .weight(2f)
                .heightIn(min = 48.dp)
                .background(
                    color = if (state.isBusy || !primaryEnabled) {
                        HarnessColors.accent400
                    } else {
                        HarnessColors.accent
                    },
                    shape = HarnessShapes.pill,
                )
                .clickable(enabled = !state.isBusy && primaryEnabled, onClick = onPrimary)
                .padding(vertical = 13.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (state.isBusy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = HarnessColors.neutral100,
                    strokeWidth = 2.5.dp,
                )
            } else {
                Text(
                    text = primaryLabel,
                    color = HarnessColors.neutral100,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}
// AI-GENERATED START: kênh OTP đọc từ màn OTP của switcher
/** How a channel code reads to a person waiting for the code. */
private fun otpChannelLabel(otpType: String): String = when (otpType.uppercase()) {
    "VOICE" -> "cuộc gọi từ tổng đài"
    "SMS", "" -> "SMS"
    else -> otpType
}
// AI-GENERATED END: kênh OTP đọc từ màn OTP của switcher
// AI-GENERATED END: the login as Acme presents it — one popup per step.
