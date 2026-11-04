Option Explicit
' A month calendar for the From / To filter boxes (opened by ThisWorkbook).
' Days outside the report period are greyed out; "Whole period" clears the box.
' Controls are made here at run time (the form's design is empty).

Public Result As Integer          ' 0 = closed, 1 = a day picked (Picked), 2 = whole period
Public Picked As Date

Private Const CELL As Single = 26
Private Const PAD As Single = 6
Private mFirst As Date            ' first of the month shown
Private mMin As Date, mMax As Date
Private mSel As Date, mHasSel As Boolean
Private mLabel As MSForms.Label
Private WithEvents mPrev As MSForms.CommandButton
Private WithEvents mNext As MSForms.CommandButton
Private WithEvents mClear As MSForms.CommandButton
Private mDays As Collection

Public Sub Setup(ByVal current As Variant, ByVal minDate As Date, ByVal maxDate As Date, ByVal title As String)
    mMin = minDate
    mMax = maxDate
    mHasSel = IsDate(current)
    If mHasSel Then mSel = CDate(current) Else mSel = minDate
    mFirst = DateSerial(Year(mSel), Month(mSel), 1)
    Me.Caption = title
    If mDays Is Nothing Then Build
    Paint
End Sub

Private Sub Build()
    Dim i As Integer, b As MSForms.CommandButton, l As MSForms.Label, h As DayButton
    Me.Width = PAD * 2 + CELL * 7 + 4
    Me.Height = PAD * 3 + CELL * 9 + 24
    Set mPrev = Me.Controls.Add("Forms.CommandButton.1", "prev")
    Place mPrev, PAD, PAD, CELL
    mPrev.Caption = ChrW(9664)
    Set mNext = Me.Controls.Add("Forms.CommandButton.1", "next")
    Place mNext, PAD + CELL * 6, PAD, CELL
    mNext.Caption = ChrW(9654)
    Set mLabel = Me.Controls.Add("Forms.Label.1", "month")
    mLabel.Left = PAD + CELL
    mLabel.Top = PAD + 6
    mLabel.Width = CELL * 5
    mLabel.Height = CELL - 6
    mLabel.TextAlign = fmTextAlignCenter
    mLabel.Font.Bold = True
    mLabel.Font.Size = 10
    For i = 0 To 6
        Set l = Me.Controls.Add("Forms.Label.1", "wd" & i)
        l.Left = PAD + CELL * i
        l.Top = PAD + CELL + 6
        l.Width = CELL
        l.Height = CELL - 8
        l.TextAlign = fmTextAlignCenter
        l.ForeColor = RGB(107, 114, 128)
        l.Caption = Mid$("MoTuWeThFrSaSu", i * 2 + 1, 2)
    Next i
    Set mDays = New Collection
    For i = 1 To 42
        Set b = Me.Controls.Add("Forms.CommandButton.1", "d" & i)
        Place b, PAD + ((i - 1) Mod 7) * CELL, PAD + CELL * 2 + ((i - 1) \ 7) * CELL, CELL
        Set h = New DayButton
        Set h.Btn = b
        Set h.Owner = Me
        mDays.Add h
    Next i
    Set mClear = Me.Controls.Add("Forms.CommandButton.1", "clear")
    Place mClear, PAD, PAD * 2 + CELL * 8, CELL * 7
    mClear.Caption = "Whole period (clear)"
End Sub

Private Sub Place(ByVal c As Object, ByVal x As Single, ByVal y As Single, ByVal w As Single)
    c.Left = x
    c.Top = y
    c.Width = w
    c.Height = CELL
End Sub

Private Sub Paint()
    Dim i As Integer, d As Date, start As Date, b As MSForms.CommandButton
    mLabel.Caption = Format$(mFirst, "mmmm yyyy")
    start = mFirst - (Weekday(mFirst, vbMonday) - 1)
    For i = 1 To 42
        d = start + i - 1
        Set b = mDays(i).Btn
        b.Caption = CStr(Day(d))
        b.Tag = CStr(CLng(d))
        b.Enabled = (d >= mMin And d <= mMax)
        b.Font.Bold = False
        If mHasSel And d = mSel Then
            b.BackColor = RGB(16, 185, 129)          ' the page's green
            b.ForeColor = RGB(255, 255, 255)
            b.Font.Bold = True
        ElseIf Month(d) = Month(mFirst) Then
            b.BackColor = RGB(255, 255, 255)
            b.ForeColor = RGB(17, 24, 39)
        Else
            b.BackColor = RGB(243, 244, 246)
            b.ForeColor = RGB(156, 163, 175)
        End If
    Next i
    mPrev.Enabled = mFirst > mMin
    mNext.Enabled = DateSerial(Year(mFirst), Month(mFirst) + 1, 1) <= mMax
End Sub

Public Sub DayClicked(ByVal serial As Long)
    Picked = CDate(serial)
    Result = 1
    Me.Hide
End Sub

Private Sub mPrev_Click()
    mFirst = DateSerial(Year(mFirst), Month(mFirst) - 1, 1)
    Paint
End Sub

Private Sub mNext_Click()
    mFirst = DateSerial(Year(mFirst), Month(mFirst) + 1, 1)
    Paint
End Sub

Private Sub mClear_Click()
    Result = 2
    Me.Hide
End Sub

Private Sub UserForm_QueryClose(Cancel As Integer, CloseMode As Integer)
    If CloseMode = vbFormControlMenu Then     ' the X: keep the box as it is
        Cancel = True
        Result = 0
        Me.Hide
    End If
End Sub
