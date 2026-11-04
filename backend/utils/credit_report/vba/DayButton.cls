Option Explicit
' One day button of DatePick: a click picks its day (the button's Tag).
Public WithEvents Btn As MSForms.CommandButton
Public Owner As Object

Private Sub Btn_Click()
    Owner.DayClicked CLng(Btn.Tag)
End Sub
